// Per-user/IP sliding-window rate limits + strict global outbound YouTube concurrency gate & token bucket.
// Keeps a self-hosted or multi-user server resilient at 1,000s of users without external Redis dependencies.

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

type WindowBucket = {
  timestamps: number[];
};

const buckets = new Map<string, WindowBucket>();
const MAX_BUCKETS = 20_000;

/**
 * Sliding-window rate limiter. Records one hit when allowed.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const cutoff = now - windowMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }
  if (bucket.timestamps.length) {
    let firstValid = 0;
    while (firstValid < bucket.timestamps.length && bucket.timestamps[firstValid] <= cutoff) {
      firstValid++;
    }
    if (firstValid > 0) bucket.timestamps.splice(0, firstValid);
  }

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { ok: false, remaining: 0, retryAfterSec };
  }

  bucket.timestamps.push(now);

  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (!b.timestamps.length || b.timestamps[b.timestamps.length - 1] <= cutoff) {
        buckets.delete(k);
      }
      if (buckets.size <= MAX_BUCKETS * 0.8) break;
    }
  }

  return { ok: true, remaining: Math.max(0, limit - bucket.timestamps.length), retryAfterSec: 0 };
}

export class YoutubeBackoffError extends Error {
  constructor(message = "YouTube temporarily backed off after rate limit") {
    super(message);
    this.name = "YoutubeBackoffError";
  }
}

export class YoutubeQueueFullError extends Error {
  constructor(message = "YouTube outbound queue saturated; serving cached data") {
    super(message);
    this.name = "YoutubeQueueFullError";
  }
}

type GateWaiter = {
  wake: () => void;
  cancel: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function resetRateLimitsForTests(): void {
  buckets.clear();
  youtubeBackoffUntil = 0;
  ytTokens = ytBucketCapacity();
  ytLastRefill = Date.now();
  ytTokenChain = Promise.resolve();
  ytInflight = 0;
  while (ytWaiters.length > 0) {
    const w = ytWaiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.cancel(new YoutubeQueueFullError("Reset"));
    }
  }
  userInflight.clear();
  for (const list of userWaiters.values()) {
    while (list.length > 0) {
      const w = list.shift();
      if (w) {
        clearTimeout(w.timer);
        w.cancel(new YoutubeQueueFullError("Reset"));
      }
    }
  }
  userWaiters.clear();
}

// ---------- Strict global outbound YouTube concurrency gate + per-user fair share + serialized token bucket + 429 circuit breaker ----------

function ytMaxConcurrent(): number {
  const n = Number(process.env.YOUTUBE_MAX_CONCURRENT);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 6;
}

function ytUserMaxConcurrent(): number {
  const n = Number(process.env.YOUTUBE_USER_MAX_CONCURRENT);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : Math.min(2, ytMaxConcurrent());
}

function ytUserMaxQueue(): number {
  const n = Number(process.env.YOUTUBE_USER_MAX_QUEUE);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 12;
}

function ytMaxQueueDepth(): number {
  const n = Number(process.env.YOUTUBE_MAX_QUEUE);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 100;
}

function ytQueueWaitMs(): number {
  const n = Number(process.env.YOUTUBE_QUEUE_WAIT_MS);
  return Number.isFinite(n) && n >= 50 ? Math.round(n) : 8_000;
}

function ytTokensPerSec(): number {
  const n = Number(process.env.YOUTUBE_RPS);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

function ytBucketCapacity(): number {
  return Math.max(ytTokensPerSec() * 2, 16);
}

let ytTokens = ytBucketCapacity();
let ytLastRefill = Date.now();
let ytTokenChain: Promise<void> = Promise.resolve();
let ytInflight = 0;
const ytWaiters: GateWaiter[] = [];
const userInflight = new Map<string, number>();
const userWaiters = new Map<string, GateWaiter[]>();
let youtubeBackoffUntil = 0;

function refillTokens(now = Date.now()): void {
  const rps = ytTokensPerSec();
  const cap = ytBucketCapacity();
  const elapsedSec = Math.max(0, (now - ytLastRefill) / 1000);
  if (elapsedSec > 0) {
    ytTokens = Math.min(cap, ytTokens + elapsedSec * rps);
    ytLastRefill = now;
  }
}

export function noteYoutubeRateLimit(retryAfterSec = 60): void {
  const until = Date.now() + Math.min(600, Math.max(15, retryAfterSec)) * 1000;
  if (until > youtubeBackoffUntil) {
    youtubeBackoffUntil = until;
  }
}

export function isYoutubeBackedOff(now = Date.now()): boolean {
  return now < youtubeBackoffUntil;
}

export function getYoutubeBackoffUntil(): number {
  return youtubeBackoffUntil;
}

/**
 * Acquire one concurrency slot atomically with bounded queue depth and wait deadline.
 * `ytInflight` is incremented BEFORE returning (or transferred directly to a woken waiter
 * without decrementing), guaranteeing `ytInflight <= ytMaxConcurrent()` at every instant.
 */
async function acquireConcurrencySlot(maxWaitMs = ytQueueWaitMs()): Promise<void> {
  const max = ytMaxConcurrent();
  if (ytInflight < max) {
    ytInflight++;
    return;
  }
  if (ytWaiters.length >= ytMaxQueueDepth()) {
    throw new YoutubeQueueFullError("YouTube outbound queue full; serving stale cached data");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: GateWaiter = {
      wake: () => {
        clearTimeout(waiter.timer);
        resolve();
      },
      cancel: (error: Error) => {
        clearTimeout(waiter.timer);
        reject(error);
      },
      timer: setTimeout(() => {
        const idx = ytWaiters.indexOf(waiter);
        if (idx !== -1) ytWaiters.splice(idx, 1);
        reject(new YoutubeQueueFullError(`YouTube outbound queue wait exceeded ${maxWaitMs}ms`));
      }, maxWaitMs),
    };
    waiter.timer.unref?.();
    ytWaiters.push(waiter);
  });
  // Slot was already reserved/transferred by releaseConcurrencySlot() before waking us.
}

function releaseConcurrencySlot(): void {
  const max = ytMaxConcurrent();
  if (ytWaiters.length > 0 && ytInflight <= max) {
    // Transfer our active slot directly to the next waiter (ytInflight stays unchanged!).
    const next = ytWaiters.shift();
    next?.wake();
    return;
  }
  ytInflight = Math.max(0, ytInflight - 1);
  // If max grew dynamically, wake additional waiters while incrementing atomically.
  while (ytInflight < max && ytWaiters.length > 0) {
    ytInflight++;
    const next = ytWaiters.shift();
    next?.wake();
  }
}

/**
 * Serialized token bucket acquisition: callers take tokens one by one in FIFO order,
 * waiting as long as needed until at least 1 token is available.
 */
function acquireRateToken(): Promise<void> {
  const task = ytTokenChain.then(async () => {
    const rps = ytTokensPerSec();
    while (true) {
      refillTokens();
      if (ytTokens >= 1) {
        ytTokens -= 1;
        return;
      }
      const waitMs = Math.max(5, Math.ceil(((1 - ytTokens) / rps) * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  });
  // Keep chain alive even if an unrelated error occurs.
  ytTokenChain = task.catch(() => {});
  return task;
}

/**
 * Per-user fair-share slot so NO single user can occupy more than `ytUserMaxConcurrent()` (default 2)
 * of the global YouTube gate slots or starve other users.
 */
async function acquireUserSlot(userId: string, maxWaitMs: number): Promise<void> {
  const max = ytUserMaxConcurrent();
  const active = userInflight.get(userId) ?? 0;
  if (active < max) {
    userInflight.set(userId, active + 1);
    return;
  }
  let queue = userWaiters.get(userId);
  if (!queue) {
    queue = [];
    userWaiters.set(userId, queue);
  }
  if (queue.length >= ytUserMaxQueue()) {
    throw new YoutubeQueueFullError("Per-user YouTube concurrency queue full; please wait");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: GateWaiter = {
      wake: () => {
        clearTimeout(waiter.timer);
        resolve();
      },
      cancel: (error: Error) => {
        clearTimeout(waiter.timer);
        reject(error);
      },
      timer: setTimeout(() => {
        const list = userWaiters.get(userId);
        if (list) {
          const idx = list.indexOf(waiter);
          if (idx !== -1) list.splice(idx, 1);
          if (!list.length) userWaiters.delete(userId);
        }
        reject(new YoutubeQueueFullError(`Per-user YouTube queue wait exceeded ${maxWaitMs}ms`));
      }, maxWaitMs),
    };
    waiter.timer.unref?.();
    queue!.push(waiter);
  });
}

function releaseUserSlot(userId: string): void {
  const max = ytUserMaxConcurrent();
  const active = userInflight.get(userId) ?? 0;
  const queue = userWaiters.get(userId);
  if (queue && queue.length > 0 && active <= max) {
    const next = queue.shift();
    if (!queue.length) userWaiters.delete(userId);
    next?.wake();
    return;
  }
  if (active <= 1) userInflight.delete(userId);
  else userInflight.set(userId, active - 1);
}

/**
 * Run an outbound YouTube fetch inside the strict per-user fair-share + global concurrency gate + serialized token bucket.
 * Fails fast if YouTube recently returned a 429/challenge or the queue is saturated so callers serve stale cached data instead.
 */
export async function withYoutubeGate<T>(
  fn: () => Promise<T>,
  options?: { allowDuringBackoff?: boolean; skipTokenBucket?: boolean; maxWaitMs?: number; userId?: string },
): Promise<T> {
  if (!options?.allowDuringBackoff && isYoutubeBackedOff()) {
    throw new YoutubeBackoffError();
  }

  const maxWaitMs = options?.maxWaitMs ?? ytQueueWaitMs();
  const fairUser =
    options?.userId && options.userId !== "background" && options.userId !== "crawler"
      ? options.userId
      : null;

  if (fairUser) {
    await acquireUserSlot(fairUser, maxWaitMs);
  }
  try {
    await acquireConcurrencySlot(maxWaitMs);
    try {
      if (!options?.skipTokenBucket) {
        await acquireRateToken();
      }
      if (!options?.allowDuringBackoff && isYoutubeBackedOff()) {
        throw new YoutubeBackoffError();
      }
      return await fn();
    } catch (error) {
      // Never let our own typed backoff/queue errors re-extend the circuit breaker window!
      if (!(error instanceof YoutubeBackoffError) && !(error instanceof YoutubeQueueFullError)) {
        const msg = (error as Error)?.message ?? "";
        if (/(?:status|returned|http)\s*429\b|\btoo many requests\b|\brate.?limit/i.test(msg)) {
          noteYoutubeRateLimit(60);
        }
      }
      throw error;
    } finally {
      releaseConcurrencySlot();
    }
  } finally {
    if (fairUser) releaseUserSlot(fairUser);
  }
}
