import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Innertube } from "youtubei.js";
import type { DiscoverFeed, Video } from "../src/lib/types.ts";
import { isPublicSignupEnabled } from "./auth.ts";
import { cached } from "./cache.ts";
import { getUserYoutubeCookie, isDbReady, upsertCatalogVideos } from "./db.ts";
import { withYoutubeGate } from "./ratelimit.ts";
import { isChannelId, timedYoutubeFetch, yt } from "./youtube.ts";

const VIDEO_ID = /^[\w-]{11}$/;
const HOME_TTL = 60 * 60_000; // 1 hour cache for calm daily edition cadence
const WATCH_NEXT_TTL = 6 * 60 * 60_000;
const MAX_SEEDS = 6;
const MAX_DISCOVER = 40;

type SeedInput = { id: string; channel?: string; title?: string };

/**
 * Per-user Google/YouTube cookies are disabled by default on public multi-user servers
 * (storing full Google session cookies on a shared multi-tenant server is a security risk).
 * Single-user/private self-hosts can use them freely, or set ALLOW_USER_YOUTUBE_COOKIES=true.
 */
export function canSaveUserYoutubeCookie(): boolean {
  if (!isDbReady()) return false;
  if (isPublicSignupEnabled() && process.env.ALLOW_USER_YOUTUBE_COOKIES?.trim().toLowerCase() !== "true") {
    return false;
  }
  return true;
}

/**
 * Normalize either a raw HTTP Cookie header ("SID=...; HSID=...") or a Netscape cookies.txt file
 * into a clean Cookie header string suitable for youtubei.js.
 */
export function normalizeYoutubeCookie(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.includes("\t") || trimmed.startsWith("# Netscape") || trimmed.startsWith("# HTTP Cookie")) {
    const pairs = new Map<string, string>();
    for (const line of trimmed.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      const cols = clean.split("\t");
      if (cols.length < 7) continue;
      const domain = cols[0].toLowerCase();
      if (!domain.includes("youtube.com") && !domain.includes("google.com")) continue;
      const name = cols[5]?.trim();
      const value = cols[6]?.trim();
      if (name && value && !/[;\r\n]/.test(name) && !/[\r\n]/.test(value)) {
        pairs.set(name, value);
      }
    }
    if (!pairs.size) return null;
    return [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const withoutHeader = trimmed.replace(/^cookie:\s*/i, "").replace(/[\r\n]+/g, " ").trim();
  const pairs = new Map<string, string>();
  for (const part of withoutHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  if (!pairs.size) return null;
  return [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function envYoutubeCookie(): string | null {
  const direct = process.env.YOUTUBE_COOKIE?.trim();
  if (direct) return normalizeYoutubeCookie(direct);

  const b64 = process.env.YTDLP_COOKIES_B64?.trim();
  if (b64) {
    try {
      const text = Buffer.from(b64, "base64").toString("utf8");
      const parsed = normalizeYoutubeCookie(text);
      if (parsed) return parsed;
    } catch {}
  }

  const filePath = process.env.YTDLP_COOKIES_PATH?.trim();
  if (filePath) {
    try {
      const text = readFileSync(filePath, "utf8");
      const parsed = normalizeYoutubeCookie(text);
      if (parsed) return parsed;
    } catch {}
  }

  return null;
}

export function resolveYoutubeCookie(
  userId: string,
  allowEnvCookie = true,
): { cookie: string | null; source: "user" | "env" | "none" } {
  if (canSaveUserYoutubeCookie()) {
    const userRaw = getUserYoutubeCookie(userId);
    if (userRaw) {
      const parsed = normalizeYoutubeCookie(userRaw);
      if (parsed) return { cookie: parsed, source: "user" };
    }
  }
  if (allowEnvCookie) {
    const env = envYoutubeCookie();
    if (env) return { cookie: env, source: "env" };
  }
  return { cookie: null, source: "none" };
}

export function getDiscoverCookieStatus(
  userId: string,
  allowEnvCookie = true,
): {
  hasCookie: boolean;
  source: "user" | "env" | "none";
  canSaveCookie: boolean;
} {
  const { cookie, source } = resolveYoutubeCookie(userId, allowEnvCookie);
  return { hasCookie: Boolean(cookie), source, canSaveCookie: canSaveUserYoutubeCookie() };
}

function cookieHash(cookie: string): string {
  return createHash("sha256").update(cookie).digest("hex").slice(0, 16);
}

/**
 * Parse YouTube relative dates like "3 days ago", "Streamed 2 weeks ago", "1 hour ago" into an ISO string.
 * Returns "" (unknown) instead of fabricating a fake date when missing/unparseable.
 */
export function parseRelativePublished(text: string | undefined, now = Date.now()): string {
  if (!text) return "";
  const clean = text.trim().toLowerCase();
  if (!clean) return "";
  if (clean.includes("just now") || clean.includes("moment")) return new Date(now).toISOString();
  const match = clean.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return "";
  }
  const n = Number(match[1]);
  const unit = match[2];
  const msMap: Record<string, number> = {
    second: 1_000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  };
  return new Date(now - n * (msMap[unit] ?? 86_400_000)).toISOString();
}

function textOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const obj = value as { text?: unknown; toString?: () => string };
    if (typeof obj.text === "string") return obj.text.trim();
    if (typeof obj.toString === "function") {
      const str = obj.toString();
      if (str && str !== "[object Object]") return str.trim();
    }
  }
  return "";
}

function parseClockToSeconds(text: string): number | null {
  const clean = text.trim();
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(clean)) return null;
  const parts = clean.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function extractBrowseId(node: any): string {
  const candidates = [
    node?.author?.id,
    node?.author?.endpoint?.payload?.browseId,
    node?.metadata?.image?.renderer_context?.command_context?.on_tap?.payload?.browseId,
    node?.metadata?.image?.avatar?.endpoint?.payload?.browseId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && isChannelId(c)) return c;
  }
  const rows = node?.metadata?.metadata?.metadata_rows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      for (const part of row?.metadata_parts ?? []) {
        const runs = part?.text?.runs;
        if (Array.isArray(runs)) {
          for (const run of runs) {
            const bid = run?.endpoint?.payload?.browseId;
            if (typeof bid === "string" && isChannelId(bid)) return bid;
          }
        }
      }
    }
  }
  try {
    const serialized = JSON.stringify(node?.metadata?.image ?? node?.author ?? "");
    const match = serialized.match(/UC[\w-]{22}/)?.[0];
    if (match && isChannelId(match)) return match;
  } catch {}
  return "";
}

/** Extract a clean Video from a youtubei.js Video, CompactVideo, GridVideo, or LockupView node. */
export function parseYoutubeNode(node: any, now = Date.now()): Video | null {
  if (!node || typeof node !== "object") return null;
  const type = String(node.type ?? "");
  if (type === "ShortsLockupView" || type === "ReelItem" || type === "ReelShelf" || type === "Playlist" || type === "CompactMix") {
    return null;
  }

  // Handle LockupView (modern YouTube Home & Watch-Next renderer).
  if (type === "LockupView") {
    const contentType = String(node.content_type ?? "");
    if (contentType && contentType !== "VIDEO" && contentType !== "PODCAST" && contentType !== "UNSPECIFIED") {
      return null;
    }
    const id = String(node.content_id ?? "");
    if (!VIDEO_ID.test(id)) return null;
    const title = textOf(node.metadata?.title);
    if (!title) return null;

    const rows = Array.isArray(node.metadata?.metadata?.metadata_rows) ? node.metadata.metadata.metadata_rows : [];
    const parts: string[] = [];
    for (const row of rows) {
      for (const part of row?.metadata_parts ?? []) {
        const t = textOf(part?.text);
        if (t) parts.push(t);
      }
    }
    const channel = parts[0] || "";
    // Only check metadata parts AFTER index 0 (exclude channel name so e.g. "Live Science" is never dropped!).
    const metaParts = parts.slice(1);
    const publishedText = metaParts.find((p) => /\bago\b/i.test(p));
    const isLive = metaParts.some((p) => /\bwatching\b|\blive now\b|\bstreaming\b|^live$/i.test(p.trim()));
    if (isLive) return null;

    let seconds: number | null = typeof node.duration?.seconds === "number" && node.duration.seconds > 0 ? node.duration.seconds : null;
    if (seconds === null && typeof node.duration?.text === "string") {
      seconds = parseClockToSeconds(node.duration.text);
    }
    if (seconds !== null && seconds <= 60) return null;

    const channelId = extractBrowseId(node);
    return {
      id,
      title,
      channelId,
      channel: channel || "YouTube",
      published: parseRelativePublished(publishedText, now),
      seconds,
      source: "discover",
    };
  }

  // Handle Video / CompactVideo / GridVideo.
  const id = String(node.video_id ?? node.id ?? "");
  if (!VIDEO_ID.test(id)) return null;
  if (node.is_live || node.is_upcoming || node.is_premiere) return null;

  const endpointUrl = String(node.endpoint?.metadata?.url ?? "");
  if (endpointUrl.includes("/shorts/")) return null;

  const title = textOf(node.title);
  if (!title) return null;

  const channel = textOf(node.author?.name ?? node.short_byline_text ?? node.byline_text);
  const channelId = extractBrowseId(node);
  let seconds: number | null =
    typeof node.duration?.seconds === "number" && node.duration.seconds > 0
      ? node.duration.seconds
      : parseClockToSeconds(textOf(node.length_text));

  if (seconds !== null && seconds <= 60) return null;

  const publishedText = textOf(node.published);
  const description = textOf(node.description_snippet).slice(0, 360) || undefined;

  return {
    id,
    title,
    channelId,
    channel: channel || "YouTube",
    published: parseRelativePublished(publishedText, now),
    seconds,
    description,
    source: "discover",
  };
}

function collectNodes(root: any, out: any[], depth = 0): void {
  if (!root || depth > 5 || out.length > 250) return;
  if (Array.isArray(root)) {
    for (const item of root) collectNodes(item, out, depth + 1);
    return;
  }
  if (typeof root !== "object") return;
  const type = String(root.type ?? "");
  if (type === "ShortsLockupView" || type === "ReelShelf" || type === "ReelItem") return;
  if (type === "Video" || type === "CompactVideo" || type === "GridVideo" || type === "LockupView") {
    out.push(root);
    return;
  }
  if (root.content) collectNodes(root.content, out, depth + 1);
  if (root.contents) collectNodes(root.contents, out, depth + 1);
  if (root.items) collectNodes(root.items, out, depth + 1);
}

async function fetchHomeFeedCandidates(cookie: string, allowBypassCache: boolean, userId?: string): Promise<Video[]> {
  const key = `discover:home:${cookieHash(cookie)}`;
  const load = async (): Promise<Video[]> =>
    withYoutubeGate(async () => {
      const client = await Innertube.create({
        cookie,
        retrieve_player: false,
        generate_session_locally: true,
        fetch: timedYoutubeFetch,
      });
      const feed = await client.getHomeFeed();
      const rawNodes: any[] = [];
      const directVideos = (feed as any).videos;
      if (Array.isArray(directVideos) && directVideos.length) {
        rawNodes.push(...directVideos);
      } else {
        collectNodes((feed as any).contents, rawNodes);
      }

      const now = Date.now();
      const seen = new Set<string>();
      const videos: Video[] = [];
      for (const node of rawNodes) {
        const v = parseYoutubeNode(node, now);
        if (!v || seen.has(v.id)) continue;
        seen.add(v.id);
        videos.push({
          ...v,
          source: "discover",
          recommendedVia: "home",
          recommendedReason: "Candidate from YouTube Home",
          // Keep source score bounded (0..15) so AI quality & personal taste always lead ranking!
          recommendedScore: Math.max(1, Math.round(((60 - videos.length) / 60) * 15)),
        });
        if (videos.length >= 60) break;
      }
      return videos;
    }, userId ? { userId } : undefined);

  if (allowBypassCache) return load();
  return cached(key, HOME_TTL, load, { namespace: "discover", staleOnError: true });
}

async function fetchWatchNextForSeed(videoId: string, userId?: string): Promise<Video[]> {
  return cached(
    `discover:next:${videoId}`,
    WATCH_NEXT_TTL,
    async () =>
      withYoutubeGate(async () => {
        const info = await (await yt()).getInfo(videoId);
        const items = Array.isArray(info.watch_next_feed) ? [...info.watch_next_feed] : [];
        const now = Date.now();
        const seen = new Set<string>();
        const out: Video[] = [];
        for (const node of items) {
          const v = parseYoutubeNode(node, now);
          if (!v || v.id === videoId || seen.has(v.id)) continue;
          seen.add(v.id);
          out.push(v);
          if (out.length >= 25) break;
        }
        return out;
      }, userId ? { userId } : undefined),
    { namespace: "discover", staleOnError: true },
  );
}

async function fetchRelatedCandidates(
  seeds: SeedInput[],
  excludeChannelIds: ReadonlySet<string>,
  excludeChannelNames: ReadonlySet<string>,
  userId?: string,
): Promise<Video[]> {
  const cleanSeeds = seeds.filter((s) => VIDEO_ID.test(s.id)).slice(0, MAX_SEEDS);
  if (!cleanSeeds.length) return [];

  const results = await Promise.all(
    cleanSeeds.map(async (seed) => {
      const list = await fetchWatchNextForSeed(seed.id, userId).catch(() => []);
      return { seed, list };
    }),
  );

  const byId = new Map<string, { video: Video; hits: number; viaChannels: string[]; rankSum: number }>();
  for (const { seed, list } of results) {
    list.forEach((video, idx) => {
      if (video.channelId && excludeChannelIds.has(video.channelId)) return;
      if (video.channel && excludeChannelNames.has(video.channel.trim().toLowerCase())) return;
      const existing = byId.get(video.id);
      const label = seed.channel?.trim() || seed.title?.trim() || "your feed";
      if (existing) {
        existing.hits += 1;
        existing.rankSum += Math.max(1, 20 - idx);
        if (!existing.viaChannels.includes(label)) existing.viaChannels.push(label);
        if (!existing.video.channelId && video.channelId) existing.video.channelId = video.channelId;
      } else {
        byId.set(video.id, {
          video: { ...video },
          hits: 1,
          viaChannels: [label],
          rankSum: Math.max(1, 20 - idx),
        });
      }
    });
  }

  const scored = [...byId.values()].map(({ video, hits, viaChannels, rankSum }) => {
    const reason =
      viaChannels.length >= 2
        ? `Across ${viaChannels.length} channels (${viaChannels.slice(0, 2).join(", ")})`
        : `Related to ${viaChannels[0]}`;
    // Bounded source tie-breaker (1..15) so AI educational score + user taste always dominate ranking.
    const rawStrength = hits * 25 + rankSum;
    const normalizedScore = Math.min(15, Math.max(1, Math.round(rawStrength / 8)));
    return {
      ...video,
      source: "discover" as const,
      recommendedVia: "related" as const,
      recommendedReason: reason,
      recommendedScore: normalizedScore,
    };
  });

  return scored
    .sort((a, b) => (b.recommendedScore ?? 0) - (a.recommendedScore ?? 0))
    .slice(0, MAX_DISCOVER);
}

/**
 * Fetch candidate recommendations from unfollowed channels.
 * Populates `video_catalog` server-side so the canonical AI judge uses authoritative metadata.
 */
export async function getDiscoverFeed(input: {
  userId: string;
  seeds: SeedInput[];
  excludeChannelIds: string[];
  excludeChannelNames?: string[];
  allowBypassCache?: boolean;
  allowEnvCookie?: boolean;
}): Promise<DiscoverFeed> {
  const exclude = new Set(input.excludeChannelIds.filter(isChannelId));
  const excludeNames = new Set((input.excludeChannelNames ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  const { cookie, source: cookieSource } = resolveYoutubeCookie(input.userId, input.allowEnvCookie !== false);
  const editionDay = new Date().toISOString().slice(0, 10);
  let fallbackReason: string | undefined;

  if (cookie) {
    try {
      const home = await fetchHomeFeedCandidates(cookie, Boolean(input.allowBypassCache), input.userId);
      const filtered = home
        .filter((v) => (!v.channelId || !exclude.has(v.channelId)) && (!v.channel || !excludeNames.has(v.channel.trim().toLowerCase())))
        .slice(0, MAX_DISCOVER);
      if (filtered.length > 0) {
        upsertCatalogVideos(filtered);
        return {
          mode: "home",
          editionDay,
          hasCookie: true,
          cookieSource,
          videos: filtered,
          fetchedAt: Date.now(),
        };
      }
      fallbackReason = "YouTube Home returned no new unfollowed videos; using Watch-Next candidates.";
    } catch (error) {
      console.error(`[discover] Home feed failed, falling back to Watch-Next: ${(error as Error).message}`);
      fallbackReason = "YouTube cookie may have expired; using Watch-Next candidates instead.";
    }
  }

  const related = await fetchRelatedCandidates(input.seeds, exclude, excludeNames, input.userId);
  if (related.length > 0) upsertCatalogVideos(related);
  return {
    mode: "related",
    editionDay,
    hasCookie: Boolean(cookie),
    cookieSource,
    fallbackReason,
    videos: related,
    fetchedAt: Date.now(),
  };
}
