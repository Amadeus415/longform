import { useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { getState, setState } from "./store";
import type { ChannelFeed, ChannelHit } from "./types";

const STALE_AFTER = 15 * 60_000;
const FOREGROUND_COOLDOWN = 5 * 60_000;
const BATCH_CHUNK = 50;
const MAX_LOCAL_JUDGMENTS = 2_000;

function trimJudgments(map: Record<string, import("./types").LlmJudgment>): Record<string, import("./types").LlmJudgment> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_LOCAL_JUDGMENTS) return map;
  entries.sort((a, b) => (b[1].judgedAt ?? 0) - (a[1].judgedAt ?? 0));
  return Object.fromEntries(entries.slice(0, MAX_LOCAL_JUDGMENTS));
}

type Status = { pending: number; failed: string[] };
let status: Status = { pending: 0, failed: [] };
const listeners = new Set<() => void>();

function setStatus(next: Partial<Status>) {
  status = { ...status, ...next };
  listeners.forEach((l) => l());
}

export function useFeedStatus(): Status {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => status);
}

let running: Promise<void> | null = null;
let lastCheckedAt = 0;

/**
 * Fetch every channel whose cached feed is missing or stale using the batched `/api/channels/batch`
 * endpoint (1 HTTP request for up to 50 channels) with a 5-minute foreground cooldown.
 */
export function refreshFeeds(force = false): Promise<void> {
  if (running) return running;
  const now = Date.now();
  const { channels, feeds } = getState();
  const hasMissing = channels.some((c) => !feeds[c.id]);
  if (!force && !hasMissing && now - lastCheckedAt < FOREGROUND_COOLDOWN) {
    return Promise.resolve();
  }

  const due = channels.filter((c) => force || !feeds[c.id] || now - feeds[c.id].fetchedAt > STALE_AFTER);
  if (!due.length) {
    lastCheckedAt = now;
    return Promise.resolve();
  }

  lastCheckedAt = now;
  setStatus({ pending: due.length, failed: [] });
  const titleById = new Map(due.map((c) => [c.id, c.title || c.id]));
  const failed: string[] = [];

  const chunks: typeof due[] = [];
  for (let i = 0; i < due.length; i += BATCH_CHUNK) chunks.push(due.slice(i, i + BATCH_CHUNK));

  running = (async () => {
    for (const chunk of chunks) {
      try {
        const res = await apiFetch("/api/channels/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunk.map((c) => c.id) }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          feeds: Record<string, ChannelFeed>;
          failed: string[];
          cachedJudgments?: Record<string, import("./types").LlmJudgment>;
        };
        const received = data.feeds ?? {};
        const passiveJudgments = data.cachedJudgments ?? {};
        const receivedAt = Date.now();
        if (Object.keys(received).length || Object.keys(passiveJudgments).length) {
          setState((s) => {
            const nextFeeds = { ...s.feeds };
            for (const [id, feed] of Object.entries(received)) {
              // Preserve true `fetchedAt` on stale SWR snapshots so "Updated X ago" never lies!
              nextFeeds[id] = feed.stale ? feed : { ...feed, fetchedAt: feed.fetchedAt || receivedAt };
            }
            const nextChannels = s.channels.map((c) => {
              const f = received[c.id];
              return f?.title && c.title !== f.title ? { ...c, title: f.title } : c;
            });
            const nextJudgments = Object.keys(passiveJudgments).length
              ? trimJudgments({ ...s.judgments, ...passiveJudgments })
              : s.judgments;
            return { feeds: nextFeeds, channels: nextChannels, judgments: nextJudgments };
          });
        }
        for (const id of data.failed ?? []) {
          failed.push(titleById.get(id) ?? id);
        }
      } catch {
        // Fallback to single-channel fetch if batch endpoint fails transiently.
        for (const ch of chunk) {
          try {
            const response = await apiFetch(`/api/channel/${ch.id}`, force ? { cache: "reload" } : undefined);
            if (!response.ok) throw new Error(String(response.status));
            const feed = (await response.json()) as ChannelFeed;
            setState((s) => ({
              feeds: { ...s.feeds, [feed.id]: { ...feed, fetchedAt: Date.now() } },
              channels: s.channels.map((c) => (c.id === feed.id && feed.title && c.title !== feed.title ? { ...c, title: feed.title } : c)),
            }));
          } catch {
            failed.push(ch.title || ch.id);
          }
        }
      }
      setStatus({ pending: Math.max(0, status.pending - chunk.length) });
    }
    setStatus({ pending: 0, failed });
    running = null;
  })();

  return running;
}

export async function findChannels(query: string): Promise<ChannelHit[]> {
  const response = await apiFetch(`/api/channels/find?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error("Search failed. Try again in a moment.");
  return response.json();
}

/** Pull channels out of a Google Takeout subscriptions.csv, or any text with channel links or IDs in it. */
export function parseSubscriptions(text: string): { id: string; title: string }[] {
  const found = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/UC[\w-]{22}/)?.[0];
    if (!id || found.has(id)) continue;
    const columns = line.split(",");
    const title = columns.length >= 3 ? columns.slice(2).join(",").replace(/^"|"$/g, "").trim() : "";
    found.set(id, title);
  }
  return [...found].map(([id, title]) => ({ id, title }));
}
