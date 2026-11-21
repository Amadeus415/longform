import { useSyncExternalStore } from "react";
import { getState, setState } from "./store";
import type { ChannelFeed, ChannelHit } from "./types";

const STALE_AFTER = 15 * 60_000;
const PARALLEL = 6;

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

/** Fetch every channel whose cached feed is missing or stale. Results land in the store as they arrive. */
export function refreshFeeds(force = false): Promise<void> {
  if (running) return running;
  const { channels, feeds } = getState();
  const due = channels.filter((c) => force || !feeds[c.id] || Date.now() - feeds[c.id].fetchedAt > STALE_AFTER);
  if (!due.length) return Promise.resolve();

  setStatus({ pending: due.length, failed: [] });
  const queue = [...due];
  const failed: string[] = [];
  const worker = async () => {
    for (let channel = queue.shift(); channel; channel = queue.shift()) {
      try {
        const response = await fetch(`/api/channel/${channel.id}`, force ? { cache: "reload" } : undefined);
        if (!response.ok) throw new Error(String(response.status));
        const feed = (await response.json()) as ChannelFeed;
        setState((s) => ({
          feeds: { ...s.feeds, [feed.id]: { ...feed, fetchedAt: Date.now() } },
          channels: s.channels.map((c) => (c.id === feed.id && feed.title && c.title !== feed.title ? { ...c, title: feed.title } : c)),
        }));
      } catch {
        failed.push(channel.title || channel.id);
      }
      setStatus({ pending: status.pending - 1 });
    }
  };
  running = Promise.all(Array.from({ length: PARALLEL }, worker)).then(() => {
    setStatus({ pending: 0, failed });
    running = null;
  });
  return running;
}

export async function findChannels(query: string): Promise<ChannelHit[]> {
  const response = await fetch(`/api/channels/find?q=${encodeURIComponent(query)}`);
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
