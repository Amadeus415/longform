import { CANONICAL_RUBRIC_VERSION } from "../src/lib/filter.ts";
import type { Video } from "../src/lib/types.ts";
import { getCachedJudgments, pruneOldCacheRows, refreshChannelPopularityAndListStale } from "./db.ts";
import { geminiModel, getJudgeStatus, judgeVideos } from "./judge.ts";
import { isYoutubeBackedOff } from "./ratelimit.ts";
import { getChannelFeed } from "./youtube.ts";

/**
 * Lightweight background channel refresher + Discover canonical AI pre-scoring queue.
 *
 * - Refreshes active subscribed channels by real subscriber popularity (adaptive batch size).
 * - Periodically prunes stale SQLite cache rows so disk usage stays bounded.
 * - Background pre-scoring ONLY queues Discover candidates under a separate 25% daily budget
 *   share so interactive Discover requests NEVER starve.
 */

const CRAWL_INTERVAL_MS = 2 * 60_000; // every 2 minutes
const STALE_CHANNEL_MS = 20 * 60_000; // refresh channels older than 20 minutes
const PRUNE_INTERVAL_MS = 60 * 60_000; // hourly SQLite cache hygiene
const MAX_QUEUE_SIZE = 200;

const judgeQueue = new Map<string, Video>();
let crawlerTimer: ReturnType<typeof setInterval> | null = null;
let lastPruneAt = 0;
let draining = false;
let crawling = false;

/** Enqueue server-fetched Discover candidates for background canonical scoring (uses separate 25% bg budget). */
export function enqueueDiscoverJudging(videos: Video[]): void {
  const status = getJudgeStatus();
  if (!status.available || status.budgetRemaining <= 0) return;

  const discoverOnly = videos.filter((v) => v.source === "discover" && v.id && v.title);
  if (!discoverOnly.length) return;

  const model = geminiModel();
  const keys = discoverOnly.map((v) => `${v.id}:${CANONICAL_RUBRIC_VERSION}:${model}`);
  const cached = getCachedJudgments(keys);

  for (const v of discoverOnly) {
    if (cached[`${v.id}:${CANONICAL_RUBRIC_VERSION}:${model}`]) continue;
    if (judgeQueue.size >= MAX_QUEUE_SIZE) break;
    judgeQueue.set(v.id, v);
  }

  if (judgeQueue.size > 0 && !draining) {
    drainJudgeQueue().catch(() => {});
  }
}

async function drainJudgeQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (judgeQueue.size > 0) {
      const status = getJudgeStatus();
      if (!status.available || status.budgetRemaining <= 0) {
        judgeQueue.clear();
        break;
      }
      const batch: Video[] = [];
      for (const [id, v] of judgeQueue) {
        batch.push(v);
        judgeQueue.delete(id);
        if (batch.length >= 15) break;
      }
      if (!batch.length) break;
      const res = await judgeVideos({
        videos: batch.map((v) => ({
          id: v.id,
          title: v.title,
          channel: v.channel,
          seconds: v.seconds,
          description: v.description,
          chapters: v.chapters?.map(([, t]) => t),
          source: "discover",
        })),
        trustedMetadata: true,
        priority: "background",
      }).catch(() => null);
      if (!res || res.error || res.budgetRemaining <= 0) {
        judgeQueue.clear();
        break;
      }
      if (judgeQueue.size > 0) await new Promise((r) => setTimeout(r, 1_000));
    }
  } finally {
    draining = false;
  }
}

function maxChannelsPerTick(): number {
  const n = Number(process.env.CRAWLER_CHANNELS_PER_TICK);
  return Number.isFinite(n) && n >= 1 ? Math.min(100, Math.round(n)) : 25;
}

async function crawlTick(): Promise<void> {
  if (crawling) return;
  crawling = true;
  try {
    const now = Date.now();
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      pruneOldCacheRows();
    }

    if (isYoutubeBackedOff()) return;

    // Adaptive throughput based on active channel pool (3..CRAWLER_CHANNELS_PER_TICK per 2-min tick, paced by global YT gate).
    const cap = maxChannelsPerTick();
    const initial = refreshChannelPopularityAndListStale(STALE_CHANNEL_MS, cap);
    const targetCount = Math.min(cap, Math.max(3, Math.ceil(initial.totalActive / 40)));
    const toRefresh = initial.stale.slice(0, targetCount);

    for (const channelId of toRefresh) {
      if (isYoutubeBackedOff()) break;
      try {
        await getChannelFeed(channelId, { background: true });
      } catch {
        // Backoff & negative caching handle upstream errors cleanly.
      }
      await new Promise((r) => setTimeout(r, 750 + Math.floor(Math.random() * 750)));
    }
  } finally {
    crawling = false;
  }
}

export function startBackgroundCrawler(): void {
  if (crawlerTimer || process.env.VERCEL || process.env.VITEST || process.env.NODE_ENV === "test") return;
  crawlerTimer = setInterval(() => {
    crawlTick().catch(() => {});
  }, CRAWL_INTERVAL_MS);
  crawlerTimer.unref?.();
}

export function stopBackgroundCrawler(): void {
  if (crawlerTimer) {
    clearInterval(crawlerTimer);
    crawlerTimer = null;
  }
}
