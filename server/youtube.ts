import { XMLParser } from "fast-xml-parser";
import { Innertube } from "youtubei.js";
import { parseChapters } from "../src/lib/chapters.ts";
import type { ChannelFeed, ChannelHit, Video } from "../src/lib/types.ts";
import { cached } from "./cache.ts";

const CHANNEL_ID = /^UC[\w-]{22}$/;
const FEED_TTL = 15 * 60_000;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

let innertube: Promise<Innertube> | undefined;
function yt(): Promise<Innertube> {
  innertube ??= Innertube.create({ retrieve_player: false, generate_session_locally: true }).catch((error) => {
    innertube = undefined;
    throw error;
  });
  return innertube;
}

export function isChannelId(id: string): boolean {
  return CHANNEL_ID.test(id);
}

/**
 * One channel's latest long-form uploads.
 *
 * The list comes from YouTube's public RSS feed of the channel's "UULF" playlist, which only holds
 * long-form uploads: no Shorts, no live streams. The feed has exact publish dates and descriptions
 * but no lengths, so lengths come from the channel's Videos tab (one InnerTube request).
 */
export function getChannelFeed(channelId: string): Promise<ChannelFeed> {
  return cached(`feed:${channelId}`, FEED_TTL, async () => {
    const [rss, lengths] = await Promise.all([fetchRss(channelId), fetchLengths(channelId).catch(() => new Map())]);
    const videos: Video[] = rss.entries.map((entry) => ({
      ...entry,
      channel: rss.title,
      seconds: lengths.get(entry.id) ?? null,
    }));
    // Fill any gaps one video at a time (rare: the Videos tab and the feed disagree).
    await Promise.all(
      videos
        .filter((video) => video.seconds === null)
        .slice(0, 5)
        .map(async (video) => (video.seconds = await fetchLength(video.id).catch(() => null))),
    );
    return { id: channelId, title: rss.title, videos, fetchedAt: Date.now() };
  });
}

type RssEntry = Omit<Video, "channel" | "seconds">;

async function fetchRss(channelId: string): Promise<{ title: string; entries: RssEntry[] }> {
  const longForm = `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${channelId.slice(2)}`;
  let response = await fetch(longForm);
  let shortsMayBeMixedIn = false;
  if (response.status === 404) {
    // Some channels have no long-form playlist yet; fall back to all uploads and drop Shorts below.
    response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    shortsMayBeMixedIn = true;
  }
  if (!response.ok) throw new Error(`YouTube feed returned ${response.status}`);

  const feed = xml.parse(await response.text()).feed ?? {};
  const entries = [feed.entry ?? []].flat() as any[];
  const title = String(feed.author?.name ?? entries[0]?.author?.name ?? "");

  return {
    title,
    entries: entries
      .filter((entry) => !(shortsMayBeMixedIn && String(entry.link?.href ?? "").includes("/shorts/")))
      .map((entry) => ({
        id: String(entry["yt:videoId"]),
        title: String(entry.title ?? ""),
        channelId,
        published: String(entry.published ?? ""),
        chapters: parseChapters(String(entry["media:group"]?.["media:description"] ?? "")),
      })),
  };
}

async function fetchLengths(channelId: string): Promise<Map<string, number>> {
  const channel = await (await yt()).getChannel(channelId);
  const tab = await channel.getVideos();
  const lengths = new Map<string, number>();
  for (const item of (tab as any).videos ?? []) {
    const id = item.id ?? item.video_id ?? item.content_id;
    const seconds = item.duration?.seconds;
    if (id && typeof seconds === "number" && seconds > 0) lengths.set(id, seconds);
  }
  return lengths;
}

const lengthCache = new Map<string, number>();
async function fetchLength(videoId: string): Promise<number | null> {
  if (lengthCache.has(videoId)) return lengthCache.get(videoId)!;
  const info = await (await yt()).getBasicInfo(videoId);
  const seconds = info.basic_info.duration;
  if (!seconds || info.basic_info.is_live || info.basic_info.is_upcoming) return null;
  lengthCache.set(videoId, seconds);
  return seconds;
}

/**
 * Turn whatever the user typed into channels: a channel URL, an @handle, a channel ID, or a name to search for.
 */
export async function findChannels(query: string): Promise<ChannelHit[]> {
  const q = query.trim();
  if (!q) return [];
  return cached(`find:${q.toLowerCase()}`, 60 * 60_000, async () => {
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
  });
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
  // YouTube moved the subscriber count between fields over the years; take whichever mentions subscribers.
  return [item.video_count?.text, item.subscriber_count?.text].find((text) => /subscriber/i.test(text ?? ""));
}

function thumbnailFrom(thumbnails: any): string | undefined {
  const list = Array.isArray(thumbnails) ? thumbnails : [];
  const url: string | undefined = list[0]?.url;
  return url?.startsWith("//") ? `https:${url}` : url;
}
