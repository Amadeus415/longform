import { useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { judgeDeterministic, lookupJudgment, needsLlmJudge, rubricHash, type Rules } from "./filter";
import { currentRules, dayKey, getState, setState } from "./store";
import type { DiscoverFeed, LlmJudgment, Video } from "./types";

const MAX_LOCAL_JUDGMENTS = 2_000;
const JUDGE_BATCH_REQUEST_LIMIT = 40;
const MAX_DRAIN_ROUNDS = 6;
const MAX_ATTEMPTS_PER_VIDEO = 2;
const RETRY_COOLDOWN_MS = 6_000;

export type DiscoverStatus = {
  loading: boolean;
  error: string | null;
  hasCookie: boolean;
  cookieSource: "user" | "env" | "none";
  canSaveCookie: boolean;
  judgeAvailable: boolean | null;
  judgeModel: string;
  judgeBudgetRemaining: number | null;
  userBudgetRemaining: number | null;
  judging: boolean;
  judgeRemaining: number;
  judgeError: string | null;
  /** Incremented whenever judge retries exhaust or settle so finite Discover editions seal immediately. */
  judgeSettledVersion: number;
};

let status: DiscoverStatus = {
  loading: false,
  error: null,
  hasCookie: false,
  cookieSource: "none",
  canSaveCookie: false,
  judgeAvailable: null,
  judgeModel: "gemini-3.5-flash-lite",
  judgeBudgetRemaining: null,
  userBudgetRemaining: null,
  judging: false,
  judgeRemaining: 0,
  judgeError: null,
  judgeSettledVersion: 0,
};

const listeners = new Set<() => void>();
function setStatus(patch: Partial<DiscoverStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

export function useDiscoverStatus(): DiscoverStatus {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => status);
}

let statusLoaded = false;
export async function refreshDiscoverStatus(force = false): Promise<void> {
  if (statusLoaded && !force) return;
  statusLoaded = true;
  try {
    const res = await apiFetch("/api/discover/status", { cache: "no-store" });
    if (!res.ok) {
      statusLoaded = false;
      return;
    }
    const data = (await res.json()) as {
      hasCookie?: boolean;
      source?: "user" | "env" | "none";
      canSaveCookie?: boolean;
      judge?: { available?: boolean; model?: string; budgetRemaining?: number };
    };
    setStatus({
      hasCookie: Boolean(data.hasCookie),
      cookieSource: data.source ?? "none",
      canSaveCookie: Boolean(data.canSaveCookie),
      judgeAvailable: typeof data.judge?.available === "boolean" ? data.judge.available : null,
      judgeModel: data.judge?.model || status.judgeModel,
      judgeBudgetRemaining: typeof data.judge?.budgetRemaining === "number" ? data.judge.budgetRemaining : null,
    });
  } catch {
    statusLoaded = false;
  }
}

let discoverInflight: Promise<void> | null = null;

function pickSeeds(): { id: string; channel?: string; title?: string }[] {
  const { progress, feeds, channels, ratings } = getState();
  const seeds: { id: string; channel?: string; title?: string }[] = [];
  const usedChannels = new Set<string>();
  const usedVideos = new Set<string>();
  const lowRated = new Set(Object.values(ratings).filter((r) => r.score <= 4).map((r) => r.videoId));

  // 1. Prioritize highly-rated videos (8–10/10) from distinct channels as strongest taste signals.
  const topRated = Object.values(ratings)
    .filter((r) => r.score >= 8)
    .sort((a, b) => b.score - a.score || b.ratedAt - a.ratedAt);
  for (const r of topRated) {
    if (usedVideos.has(r.videoId) || (r.channelId && usedChannels.has(r.channelId))) continue;
    usedVideos.add(r.videoId);
    if (r.channelId) usedChannels.add(r.channelId);
    seeds.push({ id: r.videoId, channel: r.channel, title: r.title });
    if (seeds.length >= 3) break;
  }

  // 2. Next, recently watched/finished videos from distinct channels (excluding low-rated videos).
  const recentWatched = Object.values(progress)
    .filter((p) => (p.t > 30 || p.done) && !lowRated.has(p.video.id))
    .sort((a, b) => b.at - a.at);
  for (const p of recentWatched) {
    if (usedVideos.has(p.video.id) || usedChannels.has(p.video.channelId)) continue;
    usedVideos.add(p.video.id);
    usedChannels.add(p.video.channelId);
    seeds.push({ id: p.video.id, channel: p.video.channel, title: p.video.title });
    if (seeds.length >= 4) break;
  }

  // 3. Fill remaining slots with newest uploads from distinct followed channels.
  const subscribed = new Set(channels.map((c) => c.id));
  const newestPerChannel = Object.values(feeds)
    .filter((f) => subscribed.has(f.id) && f.videos.length > 0)
    .map((f) => f.videos[0])
    .filter((v) => !lowRated.has(v.id))
    .sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));

  for (const v of newestPerChannel) {
    if (usedVideos.has(v.id) || usedChannels.has(v.channelId)) continue;
    usedVideos.add(v.id);
    usedChannels.add(v.channelId);
    seeds.push({ id: v.id, channel: v.channel, title: v.title });
    if (seeds.length >= 6) break;
  }

  return seeds;
}

/**
 * Calm Daily Discover Edition:
 * Fetches at most once per calendar day (anti-slot-machine).
 * Pass `force = true` only when connecting/disconnecting a cookie or when today's edition is empty.
 */
export function refreshDiscover(force = false): Promise<void> {
  if (discoverInflight) return discoverInflight;
  const rules = currentRules();
  if (!rules.discoverEnabled) return Promise.resolve();

  const { discover, channels, blockedChannels } = getState();
  const today = dayKey();
  const existingDay = discover?.editionDay ?? (discover?.fetchedAt ? dayKey(new Date(discover.fetchedAt)) : null);
  if (!force && discover && discover.videos.length > 0 && existingDay === today) {
    return Promise.resolve();
  }

  const seeds = pickSeeds();
  if (!seeds.length && !status.hasCookie && !force) {
    refreshDiscoverStatus().catch(() => {});
  }

  const excludeChannelIds = [...new Set([...channels.map((c) => c.id), ...blockedChannels.map((c) => c.id)])];
  const excludeChannelNames = [...new Set([...channels.map((c) => c.title), ...blockedChannels.map((c) => c.title)].filter(Boolean))];

  setStatus({ loading: true, error: null });
  discoverInflight = (async () => {
    try {
      const res = await apiFetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seeds, excludeChannelIds, excludeChannelNames, force }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errBody?.error || `Recommendations failed (${res.status})`);
      }
      const feed = (await res.json()) as DiscoverFeed;
      // Clear any previous day's locked edition IDs when starting today's edition.
      setState({ discover: { ...feed, editionDay: today, lockedEditionIds: undefined } });
      setStatus({
        loading: false,
        error: null,
        hasCookie: feed.hasCookie,
        cookieSource: feed.cookieSource ?? (feed.hasCookie ? "env" : "none"),
      });
    } catch (error) {
      setStatus({ loading: false, error: (error as Error).message });
    } finally {
      discoverInflight = null;
    }
  })();

  return discoverInflight;
}

export async function saveYoutubeCookie(cookie: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch("/api/discover/cookie", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; hasCookie?: boolean; source?: "user" | "env" | "none" };
    if (!res.ok) return { ok: false, error: data.error || "Could not save cookie." };
    setStatus({ hasCookie: Boolean(data.hasCookie), cookieSource: data.source ?? "user" });
    refreshDiscover(true).catch(() => {});
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach server." };
  }
}

export async function clearYoutubeCookie(): Promise<void> {
  try {
    const res = await apiFetch("/api/discover/cookie", { method: "DELETE" });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { hasCookie?: boolean; source?: "user" | "env" | "none" };
      setStatus({ hasCookie: Boolean(data.hasCookie), cookieSource: data.source ?? "none" });
      refreshDiscover(true).catch(() => {});
    }
  } catch {}
}

// ---------- Gemini LLM judge client (drains all unjudged survivors with retry on omissions) ----------

const attemptState = new Map<string, { count: number; nextAt: number }>();
let judgeInflight: Promise<void> | null = null;
let queuedRun: { videos: Video[]; rules: Rules; force: boolean } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** True when a candidate has exhausted its bounded judge retry budget (e.g. safety-blocked or omitted). */
export function isJudgeAttemptExhausted(videoId: string, prompt: string): boolean {
  const info = attemptState.get(`${videoId}:${rubricHash(prompt)}`);
  return Boolean(info && info.count >= MAX_ATTEMPTS_PER_VIDEO);
}

function trimJudgments(map: Record<string, LlmJudgment>): Record<string, LlmJudgment> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_LOCAL_JUDGMENTS) return map;
  entries.sort((a, b) => (b[1].judgedAt ?? 0) - (a[1].judgedAt ?? 0));
  return Object.fromEntries(entries.slice(0, MAX_LOCAL_JUDGMENTS));
}

function collectPendingCandidates(videos: Video[], rules: Rules, force: boolean): Video[] {
  const state = getState();
  const now = Date.now();
  const finished = new Set(Object.values(state.progress).filter((p) => p.done).map((p) => p.video.id));
  const blocked = new Set(state.blockedChannels.map((c) => c.id));
  const blockedNames = new Set(state.blockedChannels.map((c) => c.title.trim().toLowerCase()).filter(Boolean));
  const ctx = { now, finished, blockedChannels: blocked, blockedChannelNames: blockedNames };
  const hash = rubricHash(rules.llm.prompt);

  const candidates: Video[] = [];
  const seen = new Set<string>();
  for (const v of videos) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    if (!needsLlmJudge(v, rules)) continue;
    if (!judgeDeterministic(v, rules, ctx).show) continue;
    if (!force && lookupJudgment(v.id, rules, state.judgments)) continue;
    const attemptKey = `${v.id}:${hash}`;
    const info = attemptState.get(attemptKey);
    if (!force && info && (info.count >= MAX_ATTEMPTS_PER_VIDEO || info.nextAt > now)) continue;
    candidates.push(v);
  }
  return candidates;
}

/**
 * Score all unjudged deterministic survivors in sequential batches of 40.
 * Handles Gemini ID omissions cleanly (retries up to MAX_ATTEMPTS_PER_VIDEO with cooldown)
 * so videos never stay permanently stuck in "Waiting for AI".
 */
export function judgeFeedVideos(videos: Video[], rules: Rules, force = false): Promise<void> {
  if (!rules.llm.enabled) return Promise.resolve();
  if (status.judgeAvailable === false && !force) return Promise.resolve();
  if (judgeInflight) {
    queuedRun = { videos, rules, force };
    return judgeInflight;
  }

  const allCandidates = collectPendingCandidates(videos, rules, force);
  if (!allCandidates.length) return Promise.resolve();

  const hash = rubricHash(rules.llm.prompt);
  setStatus({ judging: true, judgeRemaining: allCandidates.length, judgeError: null });

  judgeInflight = (async () => {
    let remaining = [...allCandidates];
    let rounds = 0;
    let shouldScheduleRetry = false;

    try {
      while (remaining.length > 0 && rounds < MAX_DRAIN_ROUNDS) {
        rounds++;
        const batch = remaining.slice(0, JUDGE_BATCH_REQUEST_LIMIT);
        remaining = remaining.slice(JUDGE_BATCH_REQUEST_LIMIT);
        setStatus({ judging: true, judgeRemaining: batch.length + remaining.length });

        const now = Date.now();
        for (const c of batch) {
          const key = `${c.id}:${hash}`;
          const prev = attemptState.get(key);
          attemptState.set(key, { count: (prev?.count ?? 0) + 1, nextAt: now + RETRY_COOLDOWN_MS });
        }

        const res = await apiFetch("/api/judge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rubric: rules.llm.prompt,
            force,
            // Send IDs + source only; server uses authoritative `video_catalog` metadata.
            videos: batch.map((v) => ({
              id: v.id,
              source: v.source ?? "following",
            })),
          }),
        });

        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
          if (res.status === 429 || res.status >= 500) shouldScheduleRetry = true;
          throw new Error(errBody?.error || `AI judge failed (${res.status})`);
        }

        const data = (await res.json()) as {
          available: boolean;
          model: string;
          judgments: Record<string, LlmJudgment>;
          budgetRemaining?: number;
          userBudgetRemaining?: number;
          error?: string;
        };

        if (data.judgments && Object.keys(data.judgments).length > 0) {
          setState((s) => ({
            judgments: trimJudgments({ ...s.judgments, ...data.judgments }),
          }));
        }

        // Check for any IDs Gemini omitted even on HTTP 200 and schedule one bounded retry.
        const returnedIds = new Set(Object.values(data.judgments ?? {}).map((j) => j.videoId));
        for (const c of batch) {
          const key = `${c.id}:${hash}`;
          if (returnedIds.has(c.id)) {
            attemptState.delete(key);
          } else {
            const info = attemptState.get(key);
            if (info && info.count < MAX_ATTEMPTS_PER_VIDEO) {
              shouldScheduleRetry = true;
            }
          }
        }

        setStatus({
          judgeAvailable: data.available,
          judgeModel: data.model || status.judgeModel,
          judgeBudgetRemaining: typeof data.budgetRemaining === "number" ? data.budgetRemaining : status.judgeBudgetRemaining,
          userBudgetRemaining: typeof data.userBudgetRemaining === "number" ? data.userBudgetRemaining : status.userBudgetRemaining,
          judgeError: data.error ?? null,
        });

        if (!data.available) {
          attemptState.clear();
          shouldScheduleRetry = false;
          break;
        }
        if (data.budgetRemaining === 0 || data.userBudgetRemaining === 0 || data.error) {
          shouldScheduleRetry = false;
          break;
        }
      }
    } catch (error) {
      setStatus({ judgeError: (error as Error).message });
    } finally {
      setStatus({ judging: false, judgeRemaining: 0, judgeSettledVersion: status.judgeSettledVersion + 1 });
      judgeInflight = null;
      if (queuedRun) {
        const next = queuedRun;
        queuedRun = null;
        judgeFeedVideos(next.videos, next.rules, next.force).catch(() => {});
      } else if (shouldScheduleRetry && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          judgeFeedVideos(videos, rules, false).catch(() => {});
        }, RETRY_COOLDOWN_MS + 500);
      }
    }
  })();

  return judgeInflight;
}
