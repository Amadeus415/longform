import { XMLParser } from "fast-xml-parser";
import { Innertube } from "youtubei.js";
import { parseChapters } from "../src/lib/chapters.ts";
import type { ChannelFeed, ChannelHit, Video } from "../src/lib/types.ts";
import { cached, peekCached, putCached, remember } from "./cache.ts";
import { getStoredChannelFeed, saveStoredChannelFeed, touchCatalogVideos, updateCatalogTranscript, upsertCatalogVideos } from "./db.ts";
import { withYoutubeGate } from "./ratelimit.ts";

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;
const FEED_TTL = 15 * 60_000;
const FEED_SWR_MS = 24 * 60 * 60_000; // Serve stale channel feeds immediately up to 24h while refreshing in background
const LENGTH_TTL = 24 * 60 * 60_000;
const AVATAR_TTL = 24 * 60 * 60_000;
const INNERTUBE_TIMEOUT_MS = 12_000;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

/** Fetch wrapper enforcing a hard 12s timeout so hung InnerTube sockets never pin concurrency slots. */
export const timedYoutubeFetch: typeof fetch = (input, init) => {
  const timeoutSignal = AbortSignal.timeout(INNERTUBE_TIMEOUT_MS);
  const signal =
    init?.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([init.signal, timeoutSignal])
      : init?.signal ?? timeoutSignal;
  return fetch(input, { ...init, signal });
};

let innertube: Promise<Innertube> | undefined;
export function yt(): Promise<Innertube> {
  innertube ??= Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
    fetch: timedYoutubeFetch,
  }).catch((error) => {
    innertube = undefined;
    throw error;
  });
  return innertube;
}

export function isChannelId(id: string): boolean {
  return CHANNEL_ID.test(id);
}

export function isVideoId(id: string): boolean {
  return VIDEO_ID.test(id);
}

/** Parse ISO 8601 duration (e.g. "PT1H12M34S", "PT8M14S") from YouTube Data API v3. */
export function parseIso8601Duration(iso: string | undefined): number | null {
  if (!iso || typeof iso !== "string") return null;
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  const h = Number(match[1] ?? 0);
  const m = Number(match[2] ?? 0);
  const s = Number(match[3] ?? 0);
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : null;
}

/**
 * Optional YouTube Data API v3 batch duration lookup: fetches up to 50 video durations in 1 quota unit
 * (far safer and more scalable than InnerTube scraping when YOUTUBE_API_KEY is configured).
 */
async function fetchLengthsViaDataApi(videoIds: string[]): Promise<Map<string, number>> {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  const lengths = new Map<string, number>();
  if (!apiKey || !videoIds.length) return lengths;

  const chunks: string[][] = [];
  for (let i = 0; i < videoIds.length; i += 50) chunks.push(videoIds.slice(i, i + 50));

  for (const chunk of chunks) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,liveStreamingDetails&id=${chunk.join(",")}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) continue;
    const data = (await res.json()) as {
      items?: Array<{
        id?: string;
        contentDetails?: { duration?: string };
        liveStreamingDetails?: { actualEndTime?: string; actualStartTime?: string };
      }>;
    };
    for (const item of data.items ?? []) {
      if (!item.id) continue;
      // Skip active/upcoming live streams.
      if (item.liveStreamingDetails && !item.liveStreamingDetails.actualEndTime) continue;
      const secs = parseIso8601Duration(item.contentDetails?.duration);
      if (secs !== null) {
        lengths.set(item.id, secs);
        remember(`len:${item.id}`, LENGTH_TTL, secs, "lengths");
      }
    }
  }
  return lengths;
}

const inflightSqlRevalidate = new Set<string>();

async function fetchAndStoreChannelFeed(
  channelId: string,
  stored: ReturnType<typeof getStoredChannelFeed>,
  options?: { background?: boolean; userId?: string },
): Promise<ChannelFeed> {
  const now = Date.now();
  const touchAccess = !options?.background;
  const gateOpts = options?.userId ? { userId: options.userId } : undefined;
  const rss = await withYoutubeGate(() => fetchRss(channelId, stored?.etag, stored?.lastModified), gateOpts);

  // 304 Not Modified: RSS unchanged, reuse stored feed, bump fetchedAt, and refresh catalog `updated_at`
  // so quiet channels' videos never age out of `video_catalog`!
  if (rss.notModified && stored) {
    const refreshed: ChannelFeed = { ...stored.feed, fetchedAt: now, stale: false };
    saveStoredChannelFeed(refreshed, {
      etag: rss.etag ?? stored.etag,
      lastModified: rss.lastModified ?? stored.lastModified,
      touchAccess,
    });
    touchCatalogVideos(stored.feed.videos.map((v) => v.id));
    putCached(`feed:${channelId}`, FEED_TTL, refreshed, "feeds");
    return refreshed;
  }

  const entryIds = rss.entries.map((e) => e.id);
  const lengths = new Map<string, number>();

  // Reuse any already-known durations from stored SQLite feed or bounded LRU length cache.
  if (stored) {
    for (const v of stored.feed.videos) {
      if (typeof v.seconds === "number" && v.seconds > 0) lengths.set(v.id, v.seconds);
    }
  }
  for (const id of entryIds) {
    if (!lengths.has(id)) {
      const hit = peekCached<number>(`len:${id}`, "lengths");
      if (hit && hit.value > 0) lengths.set(id, hit.value);
    }
  }

  const missingIds = entryIds.filter((id) => !lengths.has(id));
  if (missingIds.length) {
    // Prefer official YouTube Data API when YOUTUBE_API_KEY is configured (1 quota unit for 50 videos).
    if (process.env.YOUTUBE_API_KEY?.trim()) {
      const apiLengths = await fetchLengthsViaDataApi(missingIds).catch(() => new Map<string, number>());
      for (const [id, secs] of apiLengths) lengths.set(id, secs);
    }

    // Fall back to channel Videos tab via gated InnerTube for any remaining missing durations.
    const stillMissing = entryIds.filter((id) => !lengths.has(id));
    if (stillMissing.length) {
      const tabLengths = await withYoutubeGate(() => fetchLengths(channelId), gateOpts).catch(() => new Map<string, number>());
      for (const [id, secs] of tabLengths) {
        lengths.set(id, secs);
        remember(`len:${id}`, LENGTH_TTL, secs, "lengths");
      }
    }
  }

  const videos: Video[] = rss.entries.map((entry) => ({
    ...entry,
    channel: rss.title,
    seconds: lengths.get(entry.id) ?? null,
  }));

  // Fill at most 3 remaining gaps one video at a time (only when not rate-limited).
  await Promise.all(
    videos
      .filter((video) => video.seconds === null)
      .slice(0, 3)
      .map(async (video) => {
        video.seconds = await fetchLength(video.id, options?.userId).catch(() => null);
      }),
  );

  const feed: ChannelFeed = { id: channelId, title: rss.title, videos, fetchedAt: Date.now(), stale: false };
  saveStoredChannelFeed(feed, { etag: rss.etag, lastModified: rss.lastModified, touchAccess });
  upsertCatalogVideos(videos.map((v) => ({ ...v, source: "following" })));
  // Unconditionally overwrite memory cache so SWR refreshes become visible IMMEDIATELY!
  putCached(`feed:${channelId}`, FEED_TTL, feed, "feeds");
  return feed;
}

function triggerBackgroundFeedRefresh(channelId: string, stored: ReturnType<typeof getStoredChannelFeed>): void {
  if (inflightSqlRevalidate.has(channelId)) return;
  inflightSqlRevalidate.add(channelId);
  fetchAndStoreChannelFeed(channelId, stored, { background: true })
    .catch(() => {})
    .finally(() => inflightSqlRevalidate.delete(channelId));
}

/**
 * One channel's latest long-form uploads.
 *
 * Resilient multi-tier caching for 1,000s of users:
 * 1. In-memory true-LRU cache (15 min fresh TTL + 24h stale-while-revalidate; background refresh calls `putCached`
 *    unconditionally so newly uploaded videos are visible on the very next request, never pinned stale for 15 min!).
 * 2. Persistent SQLite `channel_feeds` cache with HTTP ETag / Last-Modified conditional RSS fetches
 *    and immediate stale-while-revalidate after restarts or LRU evictions without polluting the fresh memory TTL.
 * 3. Optional YouTube Data API v3 batch duration lookup, falling back to fair-share gated InnerTube (12s timeout).
 * 4. Populates & keeps fresh the trusted server-side `video_catalog` table for poison-proof AI judging.
 */
export async function getChannelFeed(
  channelId: string,
  options?: { background?: boolean; userId?: string },
): Promise<ChannelFeed> {
  if (options?.background) {
    const stored = getStoredChannelFeed(channelId, { touchAccess: false });
    return fetchAndStoreChannelFeed(channelId, stored, { background: true });
  }

  const now = Date.now();
  const mem = peekCached<ChannelFeed>(`feed:${channelId}`, "feeds");
  if (mem) {
    if (!mem.stale) {
      return mem.value;
    }
    // Stale in memory: serve immediately marked `stale: true` and refresh asynchronously (putCached overwrites when done!).
    const age = now - (mem.value.fetchedAt ?? 0);
    if (age < FEED_SWR_MS) {
      const stored = getStoredChannelFeed(channelId, { touchAccess: true });
      triggerBackgroundFeedRefresh(channelId, stored);
      return { ...mem.value, stale: true };
    }
  }

  // Memory miss (e.g. cold restart or LRU eviction): check persistent SQLite cache BEFORE calling cached()!
  const stored = getStoredChannelFeed(channelId, { touchAccess: true });
  if (stored) {
    const age = now - stored.fetchedAt;
    if (age < FEED_TTL) {
      const remainingTtl = Math.max(5_000, FEED_TTL - age);
      putCached(`feed:${channelId}`, remainingTtl, { ...stored.feed, stale: false }, "feeds");
      return { ...stored.feed, stale: false };
    }
    if (age < FEED_SWR_MS) {
      // Serve SQLite snapshot immediately marked `stale: true`, do NOT pin it as fresh in memory,
      // and refresh in background (which calls `putCached` unconditionally once fresh data arrives!).
      triggerBackgroundFeedRefresh(channelId, stored);
      return { ...stored.feed, stale: true };
    }
  }

  // Cold miss or >24h old: deduplicate concurrent fetches via `cached()`.
  return cached(
    `feed:${channelId}`,
    FEED_TTL,
    async () => {
      try {
        return await fetchAndStoreChannelFeed(channelId, stored, { background: false, userId: options?.userId });
      } catch (error) {
        if (stored) {
          return { ...stored.feed, stale: true };
        }
        throw error;
      }
    },
    { namespace: "feeds", staleOnError: true, negativeTtlMs: 30_000 },
  );
}

type RssEntry = Omit<Video, "channel" | "seconds">;

type RssFetchResult = {
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  title: string;
  entries: RssEntry[];
};

async function fetchRss(
  channelId: string,
  etag?: string | null,
  lastModified?: string | null,
): Promise<RssFetchResult> {
  const headers: Record<string, string> = {};
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  const longForm = `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${channelId.slice(2)}`;
  let response = await fetch(longForm, { headers, signal: AbortSignal.timeout(10_000) });
  let fromLongFormFeed = true;
  let shortsMayBeMixedIn = false;

  if (response.status === 304) {
    return {
      notModified: true,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      title: "",
      entries: [],
    };
  }

  if (response.status === 404) {
    // Some channels have no long-form playlist yet; fall back to all uploads and drop Shorts below.
    response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    fromLongFormFeed = false;
    shortsMayBeMixedIn = true;
    if (response.status === 304) {
      return {
        notModified: true,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        title: "",
        entries: [],
      };
    }
  }
  if (!response.ok) throw new Error(`YouTube feed returned ${response.status}`);

  const feed = xml.parse(await response.text()).feed ?? {};
  const entries = [feed.entry ?? []].flat() as any[];
  const title = String(feed.author?.name ?? entries[0]?.author?.name ?? "");

  return {
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    title,
    entries: entries
      .filter((entry) => !(shortsMayBeMixedIn && String(entry.link?.href ?? "").includes("/shorts/")))
      .map((entry) => {
        const rawDesc = String(entry["media:group"]?.["media:description"] ?? "");
        const description = rawDesc
          .replace(/https?:\/\/\S+/gi, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 360);
        return {
          id: String(entry["yt:videoId"]),
          title: String(entry.title ?? ""),
          channelId,
          published: String(entry.published ?? ""),
          fromLongFormFeed,
          chapters: parseChapters(rawDesc),
          ...(description ? { description } : {}),
        };
      }),
  };
}

async function fetchLengths(channelId: string): Promise<Map<string, number>> {
  const channel = await (await yt()).getChannel(channelId);
  const avatar = avatarFrom(channel);
  if (avatar) remember(`avatar:${channelId}`, AVATAR_TTL, avatar, "avatars");
  const tab = await channel.getVideos();
  const lengths = new Map<string, number>();
  for (const item of (tab as any).videos ?? []) {
    const id = item.id ?? item.video_id ?? item.content_id;
    const seconds = item.duration?.seconds;
    if (id && typeof seconds === "number" && seconds > 0) lengths.set(id, seconds);
  }
  return lengths;
}

async function fetchLength(videoId: string, userId?: string): Promise<number | null> {
  const hit = peekCached<number>(`len:${videoId}`, "lengths");
  if (hit && !hit.stale) return hit.value;
  return withYoutubeGate(async () => {
    const info = await (await yt()).getBasicInfo(videoId);
    const seconds = info.basic_info.duration;
    if (!seconds || info.basic_info.is_live || info.basic_info.is_upcoming) return null;
    remember(`len:${videoId}`, LENGTH_TTL, seconds, "lengths");
    return seconds;
  }, userId ? { userId } : undefined);
}

/**
 * Fetch authoritative server-side metadata (title, channel, duration, description, chapters)
 * for a video ID not yet in `video_catalog`, preventing client metadata spoofing.
 */
export async function fetchAuthoritativeVideo(videoId: string): Promise<{
  id: string;
  title: string;
  channelId: string;
  channel: string;
  seconds: number | null;
  description?: string;
  chapters?: string[];
} | null> {
  if (!VIDEO_ID.test(videoId)) return null;
  try {
    return await withYoutubeGate(async () => {
      const info = await (await yt()).getBasicInfo(videoId);
      const bi = info.basic_info;
      if (!bi?.title) return null;
      const rawDesc = String(bi.short_description ?? "");
      const description = rawDesc
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 360);
      const chapters = parseChapters(rawDesc).map(([, t]) => t);
      const seconds = typeof bi.duration === "number" && bi.duration > 0 ? bi.duration : null;
      if (seconds) remember(`len:${videoId}`, LENGTH_TTL, seconds, "lengths");
      const record = {
        id: videoId,
        title: String(bi.title),
        channelId: String(bi.channel_id ?? ""),
        channel: String(bi.author ?? ""),
        seconds,
        ...(description ? { description } : {}),
        ...(chapters.length ? { chapters } : {}),
      };
      upsertCatalogVideos([
        {
          id: record.id,
          title: record.title,
          channelId: record.channelId,
          channel: record.channel,
          published: "",
          seconds: record.seconds,
          description: record.description,
        },
      ]);
      return record;
    });
  } catch {
    return null;
  }
}

/**
 * Fetch a concise caption/transcript excerpt (~1,000 chars) + description for a video
 * (used selectively for Discover or borderline videos so clickbait can't fool the judge).
 */
export async function fetchTranscriptExcerpt(videoId: string): Promise<{ transcript?: string; description?: string }> {
  if (!VIDEO_ID.test(videoId)) return {};
  try {
    return await withYoutubeGate(async () => {
      const info = await (await yt()).getInfo(videoId);
      const rawDesc = String(info.basic_info?.short_description ?? "");
      const description = rawDesc
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 360);

      let transcript: string | undefined;
      try {
        const transcriptInfo = await info.getTranscript();
        const segments =
          (transcriptInfo as any)?.transcript?.content?.body?.initial_segments ?? [];
        if (Array.isArray(segments) && segments.length) {
          const text = segments
            .slice(0, 45)
            .map((seg: any) => String(seg?.snippet?.text ?? "").trim())
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 1000);
          if (text.length >= 40) transcript = text;
        }
      } catch {
        // Captions may be disabled; description alone is still useful.
      }

      if (transcript || description) {
        updateCatalogTranscript(videoId, transcript ?? "", description || undefined);
      }
      return {
        ...(transcript ? { transcript } : {}),
        ...(description ? { description } : {}),
      };
    });
  } catch {
    return {};
  }
}

/** A channel's avatar, sized for the app (YouTube's image CDN resizes via the "=s<size>" suffix). */
export function getChannelAvatar(channelId: string): Promise<string | null> {
  return cached(
    `avatar:${channelId}`,
    AVATAR_TTL,
    async () => withYoutubeGate(async () => avatarFrom(await (await yt()).getChannel(channelId))),
    { namespace: "avatars", staleOnError: true },
  );
}

function avatarFrom(channel: any): string | null {
  const url = thumbnailFrom(channel?.metadata?.avatar ?? channel?.metadata?.thumbnail);
  return url ? url.replace(/=s\d+/, "=s176") : null;
}

/**
 * The avatar image itself. The server downloads each one once a day and serves it from memory, so
 * phones never hit Google's image CDN directly (it rate-limits busy addresses).
 */
export function getAvatarImage(channelId: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  return cached(
    `avatar-bytes:${channelId}`,
    AVATAR_TTL,
    async () => {
      const url = await getChannelAvatar(channelId);
      if (!url) return null;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Avatar returned ${response.status}`);
      return { bytes: await response.arrayBuffer(), type: response.headers.get("content-type") ?? "image/jpeg" };
    },
    { namespace: "avatars", staleOnError: true },
  );
}

/** Look up avatars ahead of time (a few at once), so first-run screens don't show empty circles. */
export async function warmAvatars(ids: string[]): Promise<void> {
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) await getAvatarImage(id).catch(() => null);
  };
  await Promise.all(Array.from({ length: 3 }, worker));
}

/**
 * Turn whatever the user typed into channels: a channel URL, an @handle, a channel ID, or a name to search for.
 */
export async function findChannels(query: string, userId?: string): Promise<ChannelHit[]> {
  const q = query.trim();
  if (!q) return [];
  return cached(
    `find:${q.toLowerCase()}`,
    60 * 60_000,
    async () =>
      withYoutubeGate(async () => {
        const direct = await resolveDirect(q);
        if (direct) return [direct];
        const search = await (await yt()).search(q, { type: "channel" });
        return (search.results ?? [])
          .filter((item: any) => item.type === "Channel")
          .slice(0, 8)
          .map((item: any) => ({
            id: item.id ?? item.author?.id,
            title: item.author?.name ?? "",
            handle: handleFrom(item.subscriber_count?.text) ?? handleFrom(item.author?.url),
            subscribers: subscribersFrom(item),
            thumbnail: thumbnailFrom(item.author?.thumbnails),
          }))
          .filter((hit: ChannelHit) => isChannelId(hit.id));
      }, userId ? { userId } : undefined),
    { namespace: "search", staleOnError: true },
  );
}

async function resolveDirect(q: string): Promise<ChannelHit | null> {
  const idInText = q.match(/UC[\w-]{22}/)?.[0];
  let url: string | null = null;
  if (idInText) url = `https://www.youtube.com/channel/${idInText}`;
  else if (/^@[\w.-]+$/.test(q)) url = `https://www.youtube.com/${q}`;
  else if (/youtube\.com\/|youtu\.be\//.test(q)) url = q.startsWith("http") ? q : `https://${q}`;
  if (!url) return null;

  const client = await yt();
  let id = idInText;
  if (!id) {
    const endpoint = await client.resolveURL(url).catch(() => null);
    id = (endpoint?.payload as any)?.browseId;
    if (!id && /\/watch|youtu\.be\//.test(url)) {
      const videoId = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1];
      if (videoId) id = (await client.getBasicInfo(videoId).catch(() => null))?.basic_info.channel_id;
    }
  }
  if (!id || !isChannelId(id)) return null;

  const channel = await client.getChannel(id).catch(() => null);
  return {
    id,
    title: channel?.metadata?.title ?? "",
    handle: handleFrom(channel?.metadata?.vanity_channel_url),
    subscribers: JSON.stringify(channel?.header ?? {}).match(/"([^"]{1,20} subscribers)"/)?.[1],
    thumbnail: thumbnailFrom(channel?.metadata?.avatar ?? channel?.metadata?.thumbnail),
  };
}

function handleFrom(value?: string): string | undefined {
  return value?.match(/@[\w.-]+/)?.[0];
}

function subscribersFrom(item: any): string | undefined {
  return [item.video_count?.text, item.subscriber_count?.text].find((text) => /subscriber/i.test(text ?? ""));
}

function thumbnailFrom(thumbnails: any): string | undefined {
  const list = Array.isArray(thumbnails) ? thumbnails : [];
  const url: string | undefined = list[0]?.url;
  return url?.startsWith("//") ? `https:${url}` : url;
}
