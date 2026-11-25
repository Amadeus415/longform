import { useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { getState, setState } from "./store";
import type { NewsSource, NewsSourceFeed, NewsSourceHit } from "./types";

const STALE_AFTER = 20 * 60_000;
const PARALLEL = 6;

type Status = { pending: number; failed: string[] };
let status: Status = { pending: 0, failed: [] };
const listeners = new Set<() => void>();

function setStatus(next: Partial<Status>) {
  status = { ...status, ...next };
  listeners.forEach((l) => l());
}

export function useNewsStatus(): Status {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => status);
}

let running: Promise<void> | null = null;

/** Fetch every news source whose cached feed is missing or stale. Results land in the store as they arrive. */
export function refreshNews(force = false): Promise<void> {
  if (running) return running;
  const { newsSources, newsFeeds } = getState();
  const due = newsSources.filter((s) => force || !newsFeeds[s.id] || Date.now() - newsFeeds[s.id].fetchedAt > STALE_AFTER);
  if (!due.length) return Promise.resolve();

  setStatus({ pending: due.length, failed: [] });
  const queue = [...due];
  const failed: string[] = [];
  const worker = async () => {
    for (let source = queue.shift(); source; source = queue.shift()) {
      try {
        const res = await apiFetch(`/api/news/source?id=${encodeURIComponent(source.id)}`, force ? { cache: "reload" } : undefined);
        if (!res.ok) throw new Error(String(res.status));
        const feed = (await res.json()) as NewsSourceFeed;
        setState((s) => ({
          newsFeeds: { ...s.newsFeeds, [feed.id]: { ...feed, fetchedAt: Date.now() } },
          newsSources: s.newsSources.map((src) =>
            src.id === feed.id
              ? {
                  ...src,
                  title: feed.title || src.title,
                  handle: feed.handle ?? src.handle,
                  siteUrl: feed.siteUrl ?? src.siteUrl,
                  avatar: feed.avatar ?? src.avatar,
                }
              : src,
          ),
        }));
      } catch {
        failed.push(source.title || source.id);
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

export async function findNewsSources(query: string): Promise<NewsSourceHit[]> {
  const res = await apiFetch(`/api/news/find?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error("Search failed. Try again in a moment.");
  return res.json();
}

/** Pull RSS/Atom feeds out of an OPML export (Feedly, NetNewsWire, Inoreader, etc.). */
export function parseOpml(text: string): NewsSource[] {
  const found = new Map<string, NewsSource>();
  const outlines = text.match(/<outline\b[^>]*>/gi) ?? [];
  for (const tag of outlines) {
    const xmlUrl = attr(tag, "xmlUrl");
    if (!xmlUrl || !/^https?:\/\//i.test(xmlUrl)) continue;
    const id = `rss:${xmlUrl}`;
    if (found.has(id)) continue;
    const title = decodeAttr(attr(tag, "title") || attr(tag, "text") || hostOf(xmlUrl));
    const htmlUrl = attr(tag, "htmlUrl");
    found.set(id, {
      id,
      kind: "rss",
      title,
      siteUrl: htmlUrl && /^https?:\/\//i.test(htmlUrl) ? htmlUrl : undefined,
    });
  }
  return [...found.values()];
}

function attr(tag: string, name: string): string {
  return tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1]?.trim() ?? "";
}

function decodeAttr(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
