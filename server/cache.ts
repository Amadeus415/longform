// Split true-LRU in-memory cache with in-flight deduplication, negative error caching,
// and stale-on-error support so upstream YouTube 429s never cause thundering herds.

type Entry = {
  value: Promise<unknown>;
  resolved?: unknown;
  hasResolved?: boolean;
  expires: number;
  revalidating?: boolean;
};

type PoolConfig = {
  maxEntries: number;
};

export type CacheNamespace = "feeds" | "avatars" | "discover" | "search" | "audio" | "lengths" | "default";

const POOL_LIMITS: Record<CacheNamespace, PoolConfig> = {
  feeds: { maxEntries: 4_000 },
  avatars: { maxEntries: 4_000 },
  discover: { maxEntries: 2_000 },
  search: { maxEntries: 1_000 },
  audio: { maxEntries: 1_000 },
  lengths: { maxEntries: 10_000 },
  default: { maxEntries: 2_000 },
};

const pools = new Map<CacheNamespace, Map<string, Entry>>();
const negativeErrors = new Map<string, { until: number; message: string }>();
const MAX_NEGATIVE_ENTRIES = 5_000;

function poolOf(ns: CacheNamespace): Map<string, Entry> {
  let map = pools.get(ns);
  if (!map) {
    map = new Map<string, Entry>();
    pools.set(ns, map);
  }
  return map;
}

function namespaceForKey(key: string): CacheNamespace {
  if (key.startsWith("feed:")) return "feeds";
  if (key.startsWith("avatar")) return "avatars";
  if (key.startsWith("discover:")) return "discover";
  if (key.startsWith("find:")) return "search";
  if (key.startsWith("audio:")) return "audio";
  if (key.startsWith("len:")) return "lengths";
  return "default";
}

function touchLru(pool: Map<string, Entry>, key: string, entry: Entry): void {
  pool.delete(key);
  pool.set(key, entry);
}

function evictOverflow(pool: Map<string, Entry>, maxEntries: number): void {
  while (pool.size > maxEntries) {
    const oldest = pool.keys().next().value;
    if (oldest === undefined) break;
    pool.delete(oldest);
  }
}

export type CachedOptions = {
  namespace?: CacheNamespace;
  /** If upstream fails and we have a previously resolved value, serve it instead of failing. Default true. */
  staleOnError?: boolean;
  /** Cooldown (ms) after an upstream error when no stale value exists, preventing thundering herds. Default 30s. */
  negativeTtlMs?: number;
  /**
   * Serve expired cached values immediately while revalidating asynchronously in the background
   * for up to this many ms past `expires` (eliminates latency spikes and upstream stalls under load).
   */
  staleWhileRevalidateMs?: number;
};

export function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  options: CachedOptions = {},
): Promise<T> {
  const ns = options.namespace ?? namespaceForKey(key);
  const pool = poolOf(ns);
  const now = Date.now();
  const hit = pool.get(key);

  if (hit && hit.expires > now) {
    touchLru(pool, key, hit);
    return hit.value as Promise<T>;
  }

  const neg = negativeErrors.get(key);
  const swrMs = options.staleWhileRevalidateMs ?? 0;

  // Stale-while-revalidate: serve previously resolved value immediately and refresh in background (deduplicated).
  if (hit && hit.hasResolved && swrMs > 0 && now < hit.expires + swrMs) {
    touchLru(pool, key, hit);
    if (!hit.revalidating && !(neg && neg.until > now)) {
      hit.revalidating = true;
      const negativeTtlMs = options.negativeTtlMs ?? 30_000;
      load().then(
        (result) => {
          negativeErrors.delete(key);
          hit.resolved = result;
          hit.hasResolved = true;
          hit.value = Promise.resolve(result);
          hit.expires = Date.now() + ttlMs;
          hit.revalidating = false;
        },
        (error) => {
          const msg = (error as Error)?.message || "Upstream request failed";
          if (negativeTtlMs > 0) {
            negativeErrors.set(key, { until: Date.now() + negativeTtlMs, message: msg });
            if (negativeErrors.size > MAX_NEGATIVE_ENTRIES) {
              const oldestNeg = negativeErrors.keys().next().value;
              if (oldestNeg !== undefined) negativeErrors.delete(oldestNeg);
            }
          }
          hit.revalidating = false;
        },
      );
    }
    return Promise.resolve(hit.resolved as T);
  }

  // If this key recently failed and we have no stale fallback, fail fast during cooldown.
  if (neg && neg.until > now) {
    if (hit?.hasResolved && options.staleOnError !== false) {
      touchLru(pool, key, hit);
      return Promise.resolve(hit.resolved as T);
    }
    return Promise.reject(new Error(neg.message));
  }

  const prevResolved = hit?.hasResolved ? hit.resolved : undefined;
  const hasPrev = Boolean(hit?.hasResolved);
  const staleOnError = options.staleOnError !== false;
  const negativeTtlMs = options.negativeTtlMs ?? 30_000;

  const entry: Entry = {
    value: null as unknown as Promise<unknown>,
    resolved: prevResolved,
    hasResolved: hasPrev,
    expires: now + ttlMs,
  };

  const promise = load().then(
    (result) => {
      negativeErrors.delete(key);
      entry.resolved = result;
      entry.hasResolved = true;
      entry.expires = Date.now() + ttlMs;
      return result;
    },
    (error) => {
      const msg = (error as Error)?.message || "Upstream request failed";
      if (negativeTtlMs > 0) {
        negativeErrors.set(key, { until: Date.now() + negativeTtlMs, message: msg });
        if (negativeErrors.size > MAX_NEGATIVE_ENTRIES) {
          const oldestNeg = negativeErrors.keys().next().value;
          if (oldestNeg !== undefined) negativeErrors.delete(oldestNeg);
        }
      }
      if (hasPrev && staleOnError) {
        // Keep serving stale value for the cooldown window rather than failing closed.
        entry.value = Promise.resolve(prevResolved);
        entry.expires = Date.now() + Math.max(negativeTtlMs, 60_000);
        return prevResolved as T;
      }
      if (pool.get(key) === entry) pool.delete(key);
      throw error;
    },
  );

  entry.value = promise;
  pool.delete(key);
  pool.set(key, entry);
  evictOverflow(pool, POOL_LIMITS[ns].maxEntries);

  return promise;
}

/** Read a resolved cached value synchronously (even if stale) if present. */
export function peekCached<T>(key: string, namespace?: CacheNamespace): { value: T; stale: boolean } | null {
  const ns = namespace ?? namespaceForKey(key);
  const pool = poolOf(ns);
  const hit = pool.get(key);
  if (!hit || !hit.hasResolved) return null;
  touchLru(pool, key, hit);
  return { value: hit.resolved as T, stale: hit.expires <= Date.now() };
}

/** Store a value someone already has in hand, unless a fresh one is cached. */
export function remember<T>(key: string, ttlMs: number, value: T, namespace?: CacheNamespace): void {
  const ns = namespace ?? namespaceForKey(key);
  const pool = poolOf(ns);
  const hit = pool.get(key);
  if (!hit || hit.expires <= Date.now()) {
    pool.delete(key);
    pool.set(key, { value: Promise.resolve(value), resolved: value, hasResolved: true, expires: Date.now() + ttlMs });
    evictOverflow(pool, POOL_LIMITS[ns].maxEntries);
  }
}

/** Unconditionally write a fresh resolved value into the cache (used when background SWR refresh finishes). */
export function putCached<T>(key: string, ttlMs: number, value: T, namespace?: CacheNamespace): void {
  const ns = namespace ?? namespaceForKey(key);
  const pool = poolOf(ns);
  negativeErrors.delete(key);
  pool.delete(key);
  pool.set(key, {
    value: Promise.resolve(value),
    resolved: value,
    hasResolved: true,
    expires: Date.now() + ttlMs,
    revalidating: false,
  });
  evictOverflow(pool, POOL_LIMITS[ns].maxEntries);
}

export function forget(key: string, namespace?: CacheNamespace): void {
  const ns = namespace ?? namespaceForKey(key);
  poolOf(ns).delete(key);
  negativeErrors.delete(key);
}

/** Clear all cache pools (primarily for tests). */
export function clearAllCaches(): void {
  pools.clear();
  negativeErrors.clear();
}
