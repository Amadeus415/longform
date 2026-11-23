import { XMLParser } from "fast-xml-parser";
import type { NewsItem, NewsSourceFeed, NewsSourceHit, NewsSourceKind } from "../src/lib/types.ts";
import { cached, remember } from "./cache.ts";

const FEED_TTL = 15 * 60_000;
const AVATAR_TTL = 24 * 60 * 60_000;
const FETCH_TIMEOUT = 9_000;
const UA = "Longform/0.1 (+https://github.com/Amadeus415/longform)";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true,
});

const HN_FEEDS: Record<string, { title: string; tag: string; siteUrl: string }> = {
  front_page: { title: "Hacker News", tag: "front_page", siteUrl: "https://news.ycombinator.com" },
  show: { title: "Show HN", tag: "show_hn", siteUrl: "https://news.ycombinator.com/show" },
  ask: { title: "Ask HN", tag: "ask_hn", siteUrl: "https://news.ycombinator.com/ask" },
};

export function parseSourceId(id: string): { kind: NewsSourceKind; ref: string } | null {
  if (id.startsWith("bsky:")) {
    const handle = id.slice(5).trim().toLowerCase().replace(/^@/, "");
    if (/^[a-z0-9][a-z0-9.-]{1,120}$/.test(handle) && handle.includes(".")) return { kind: "bsky", ref: handle };
    return null;
  }
  if (id.startsWith("hn:")) {
    const ref = id.slice(3).trim();
    return ref in HN_FEEDS ? { kind: "hn", ref } : null;
  }
  if (id.startsWith("rss:")) {
    const url = id.slice(4).trim();
    return isSafeHttpUrl(url) ? { kind: "rss", ref: url } : null;
  }
  return null;
}

export function isSafeHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  if (/^(fc|fd|fe80)/i.test(host.replace(/^\[|\]$/g, ""))) return false;
  return true;
}

export function getNewsSourceFeed(sourceId: string): Promise<NewsSourceFeed> {
  const parsed = parseSourceId(sourceId);
  if (!parsed) throw new Error("Invalid news source ID");
  return cached(`news:${sourceId}`, FEED_TTL, async () => {
    if (parsed.kind === "bsky") return fetchBlueskyFeed(sourceId, parsed.ref);
    if (parsed.kind === "hn") return fetchHackerNewsFeed(sourceId, parsed.ref);
    return fetchRssFeed(sourceId, parsed.ref);
  });
}

// ---------- Bluesky (public AppView, no auth required) ----------

async function fetchBlueskyFeed(sourceId: string, handle: string): Promise<NewsSourceFeed> {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=30`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`Bluesky returned ${res.status}`);
  const data = (await res.json()) as any;
  const feedEntries: any[] = Array.isArray(data.feed) ? data.feed : [];

  // Prefer profile info from the author's own post; fall back to a profile lookup if all recent items are reposts.
  let author = feedEntries.find((e) => e.post?.author?.handle?.toLowerCase() === handle)?.post?.author;
  if (!author) {
    const profRes = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    }).catch(() => null);
    if (profRes?.ok) author = await profRes.json().catch(() => null);
  }

  const sourceTitle = cleanText(author?.displayName || handle);
  const avatar: string | undefined = typeof author?.avatar === "string" ? author.avatar : undefined;
  if (avatar) remember(`news-avatar:${sourceId}`, AVATAR_TTL, avatar);

  const items: NewsItem[] = [];
  for (const entry of feedEntries) {
    const post = entry?.post;
    const record = post?.record;
    if (!post?.uri || !record) continue;

    const postAuthor = post.author ?? {};
    const postHandle: string = postAuthor.handle ?? handle;
    const rkey = String(post.uri).split("/").pop() ?? "";
    const postUrl = `https://bsky.app/profile/${postHandle}/post/${rkey}`;
    const rawText = cleanText(record.text ?? "");
    const isRepost = Boolean(entry.reason?.$type?.includes("reasonRepost"));
    const isReply = Boolean(entry.reply || record.reply);

    const external = post.embed?.external ?? post.embed?.media?.external;
    const linkUrl = typeof external?.uri === "string" && isSafeHttpUrl(external.uri) ? external.uri : undefined;
    const linkTitle = cleanText(external?.title ?? "");
    const linkDesc = cleanText(external?.description ?? "");

    const quotedRecord = post.embed?.record?.value
      ? post.embed.record
      : post.embed?.record?.record?.value
        ? post.embed.record.record
        : null;
    const quotedText = quotedRecord?.value?.text ? cleanText(quotedRecord.value.text) : undefined;
    const quotedAuthor = quotedRecord?.author?.displayName || quotedRecord?.author?.handle || undefined;

    const primaryUrl = linkUrl ?? postUrl;
    const body = rawText || linkDesc || quotedText || "";
    const title = linkTitle || headlineFrom(rawText || linkDesc || quotedText || "Post");
    const published = toIso(record.createdAt ?? post.indexedAt);
    if (!published || (!title && !body)) continue;

    items.push({
      id: `bsky:${post.uri}`,
      sourceId,
      sourceTitle,
      sourceKind: "bsky",
      author: cleanText(postAuthor.displayName || postHandle),
      handle: `@${postHandle}`,
      title,
      text: body,
      url: primaryUrl,
      discussionUrl: linkUrl ? postUrl : undefined,
      domain: domainOf(primaryUrl),
      published,
      isRepost,
      isReply,
      quotedText,
      quotedAuthor,
    });
  }

  return {
    id: sourceId,
    kind: "bsky",
    title: sourceTitle,
    handle: `@${handle}`,
    siteUrl: `https://bsky.app/profile/${handle}`,
    avatar,
    items,
    fetchedAt: Date.now(),
  };
}

// ---------- Hacker News (Algolia public API) ----------

async function fetchHackerNewsFeed(sourceId: string, ref: string): Promise<NewsSourceFeed> {
  const cfg = HN_FEEDS[ref];
  const url = `https://hn.algolia.com/api/v1/search?tags=${cfg.tag}&hitsPerPage=30`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`Hacker News returned ${res.status}`);
  const data = (await res.json()) as any;
  const hits: any[] = Array.isArray(data.hits) ? data.hits : [];

  const items: NewsItem[] = hits
    .map((hit): NewsItem | null => {
      const id = String(hit.objectID ?? "");
      const title = cleanText(hit.title ?? "");
      if (!id || !title) return null;
      const discussionUrl = `https://news.ycombinator.com/item?id=${id}`;
      const primaryUrl = typeof hit.url === "string" && isSafeHttpUrl(hit.url) ? hit.url : discussionUrl;
      const text = stripHtml(hit.story_text ?? "") || title;
      const published = toIso(hit.created_at);
      if (!published) return null;
      return {
        id: `hn:${id}`,
        sourceId,
        sourceTitle: cfg.title,
        sourceKind: "hn",
        author: cleanText(hit.author ?? "HN"),
        title,
        text,
        url: primaryUrl,
        discussionUrl: primaryUrl !== discussionUrl ? discussionUrl : undefined,
        domain: domainOf(primaryUrl),
        published,
      };
    })
    .filter((x): x is NewsItem => x !== null);

  return {
    id: sourceId,
    kind: "hn",
    title: cfg.title,
    siteUrl: cfg.siteUrl,
    items,
    fetchedAt: Date.now(),
  };
}

// ---------- RSS / Atom (any public feed) ----------

async function fetchRssFeed(sourceId: string, feedUrl: string): Promise<NewsSourceFeed> {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Feed returned ${res.status}`);
  const raw = await res.text();
  const parsed = parseXmlFeed(raw, sourceId, feedUrl);
  if (parsed.avatar) remember(`news-avatar:${sourceId}`, AVATAR_TTL, parsed.avatar);
  return parsed;
}

export function parseXmlFeed(rawXml: string, sourceId: string, feedUrl: string): NewsSourceFeed {
  const doc = xml.parse(rawXml);
  const channel = doc?.rss?.channel ?? doc?.["rdf:RDF"]?.channel;
  const atom = doc?.feed;

  if (channel) {
    const rawItems = [channel.item ?? doc?.["rdf:RDF"]?.item ?? []].flat().filter(Boolean);
    const title = cleanText(textOf(channel.title) || domainOf(feedUrl) || feedUrl);
    const siteUrl = firstHref(channel.link) || originOf(feedUrl);
    const avatar = safeUrl(textOf(channel.image?.url));

    const items = rawItems
      .slice(0, 30)
      .map((entry: any): NewsItem | null => {
        const itemTitle = cleanText(textOf(entry.title));
        const link = firstHref(entry.link) || safeUrl(textOf(entry.guid)) || siteUrl || feedUrl;
        const rawSummary = textOf(entry.description) || textOf(entry["content:encoded"]) || textOf(entry.summary);
        const body = stripHtml(rawSummary);
        const published = toIso(textOf(entry.pubDate) || textOf(entry["dc:date"]) || textOf(entry.published) || textOf(entry.updated));
        const id = textOf(entry.guid) || link || `${sourceId}:${itemTitle}`;
        if (!published || (!itemTitle && !body)) return null;
        return {
          id: `rss:${id}`,
          sourceId,
          sourceTitle: title,
          sourceKind: "rss",
          author: cleanText(textOf(entry["dc:creator"]) || textOf(entry.author?.name ?? entry.author) || title),
          title: itemTitle || headlineFrom(body),
          text: body || itemTitle,
          url: link,
          domain: domainOf(link),
          published,
        };
      })
      .filter((x): x is NewsItem => x !== null);

    return { id: sourceId, kind: "rss", title, siteUrl, avatar, items, fetchedAt: Date.now() };
  }

  if (atom) {
    const rawEntries = [atom.entry ?? []].flat().filter(Boolean);
    const title = cleanText(textOf(atom.title) || domainOf(feedUrl) || feedUrl);
    const siteUrl = atomLink(atom.link, "alternate") || originOf(feedUrl);
    const avatar = safeUrl(textOf(atom.icon) || textOf(atom.logo));

    const items = rawEntries
      .slice(0, 30)
      .map((entry: any): NewsItem | null => {
        const itemTitle = cleanText(textOf(entry.title));
        const link = atomLink(entry.link, "alternate") || firstHref(entry.link) || siteUrl || feedUrl;
        const rawSummary = textOf(entry.summary) || textOf(entry.content);
        const body = stripHtml(rawSummary);
        const published = toIso(textOf(entry.published) || textOf(entry.updated));
        const id = textOf(entry.id) || link || `${sourceId}:${itemTitle}`;
        if (!published || (!itemTitle && !body)) return null;
        return {
          id: `rss:${id}`,
          sourceId,
          sourceTitle: title,
          sourceKind: "rss",
          author: cleanText(textOf(entry.author?.name ?? entry.author) || title),
          title: itemTitle || headlineFrom(body),
          text: body || itemTitle,
          url: link,
          domain: domainOf(link),
          published,
        };
      })
      .filter((x): x is NewsItem => x !== null);

    return { id: sourceId, kind: "rss", title, siteUrl, avatar, items, fetchedAt: Date.now() };
  }

  throw new Error("URL did not return a recognized RSS or Atom feed");
}

// ---------- Discovery: search Bluesky, RSS/Atom URL, website auto-discovery, Mastodon, Substack, HN ----------

export async function findNewsSources(query: string): Promise<NewsSourceHit[]> {
  const q = query.trim();
  if (!q) return [];
  return cached(`news-find:${q.toLowerCase()}`, 30 * 60_000, async () => {
    // 1. Hacker News shortcut
    if (/^(hn|hacker\s*news)$/i.test(q)) {
      return Object.entries(HN_FEEDS).map(([key, cfg]) => ({
        id: `hn:${key}`,
        kind: "hn" as const,
        title: cfg.title,
        about: "Public Hacker News stories",
        siteUrl: cfg.siteUrl,
      }));
    }

    // 2. Mastodon handle: @user@instance.tld -> https://instance.tld/@user.rss
    const masto = q.match(/^@?([\w.-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i);
    if (masto) {
      const feedUrl = `https://${masto[2]}/@${masto[1]}.rss`;
      const hit = await probeRssHit(feedUrl);
      if (hit) return [hit];
    }

    // 3. Bluesky profile URL: https://bsky.app/profile/<handle>
    const bskyUrl = q.match(/bsky\.app\/profile\/([a-z0-9.-]+)/i);
    if (bskyUrl) {
      const hit = await resolveBlueskyProfile(bskyUrl[1]);
      if (hit) return [hit];
    }

    // 4. Direct URL or domain: try RSS/Atom directly, or discover <link rel="alternate"> from HTML, and also check if it's a Bluesky domain handle.
    const looksLikeUrl = /^https?:\/\//i.test(q) || (!/\s/.test(q) && /\.[a-z]{2,}(\/|$)/i.test(q) && !q.startsWith("@"));
    if (looksLikeUrl) {
      const normalizedUrl = /^https?:\/\//i.test(q) ? q : `https://${q}`;
      const results: NewsSourceHit[] = [];
      const [rssHit, bskyHit] = await Promise.all([
        discoverRssFromUrl(normalizedUrl).catch(() => null),
        !/\/.+/.test(q.replace(/^https?:\/\//i, "")) ? resolveBlueskyProfile(q.replace(/^https?:\/\//i, "").replace(/\/$/, "")).catch(() => null) : Promise.resolve(null),
      ]);
      if (rssHit) results.push(rssHit);
      if (bskyHit) results.push(bskyHit);
      if (results.length) return results;
    }

    // 5. Bluesky @handle or free-text search
    const cleanQ = q.replace(/^@/, "");
    const searchUrl = `https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead?q=${encodeURIComponent(cleanQ)}&limit=8`;
    const res = await fetch(searchUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`Bluesky search returned ${res.status}`);
    const data = (await res.json()) as any;
    const actors: any[] = Array.isArray(data.actors) ? data.actors : [];
    return actors
      .filter((a) => typeof a.handle === "string")
      .map((a): NewsSourceHit => ({
        id: `bsky:${a.handle.toLowerCase()}`,
        kind: "bsky",
        title: cleanText(a.displayName || a.handle),
        handle: `@${a.handle}`,
        about: "Bluesky · public feed",
        siteUrl: `https://bsky.app/profile/${a.handle}`,
        avatar: typeof a.avatar === "string" ? a.avatar : undefined,
      }));
  });
}

async function resolveBlueskyProfile(handle: string): Promise<NewsSourceHit | null> {
  const clean = handle.trim().toLowerCase().replace(/^@/, "");
  const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(clean)}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) return null;
  const a = (await res.json()) as any;
  if (!a?.handle) return null;
  return {
    id: `bsky:${String(a.handle).toLowerCase()}`,
    kind: "bsky",
    title: cleanText(a.displayName || a.handle),
    handle: `@${a.handle}`,
    about: cleanText(a.description || "Bluesky · public feed").slice(0, 110),
    siteUrl: `https://bsky.app/profile/${a.handle}`,
    avatar: typeof a.avatar === "string" ? a.avatar : undefined,
  };
}

async function discoverRssFromUrl(url: string): Promise<NewsSourceHit | null> {
  if (!isSafeHttpUrl(url)) return null;
  const direct = await probeRssHit(url);
  if (direct) return direct;

  // Fetch the page HTML and look for <link rel="alternate" type="application/rss+xml|atom+xml">.
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 100_000);
  const candidates: string[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    if (!/rel=["'][^"']*alternate/i.test(tag)) continue;
    if (!/type=["']application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) {
      try {
        candidates.push(new URL(href, url).toString());
      } catch {}
    }
  }
  // Substack & common blog paths
  const origin = originOf(url);
  if (origin) candidates.push(`${origin}/feed`, `${origin}/rss.xml`, `${origin}/feed.xml`);

  for (const candidate of [...new Set(candidates)].slice(0, 4)) {
    const hit = await probeRssHit(candidate);
    if (hit) return hit;
  }
  return null;
}

async function probeRssHit(feedUrl: string): Promise<NewsSourceHit | null> {
  if (!isSafeHttpUrl(feedUrl)) return null;
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  }).catch(() => null);
  if (!res?.ok) return null;
  const text = await res.text();
  if (!/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 1200))) return null;
  const parsed = parseXmlFeed(text, `rss:${feedUrl}`, feedUrl);
  return {
    id: `rss:${feedUrl}`,
    kind: "rss",
    title: parsed.title,
    about: `${domainOf(parsed.siteUrl || feedUrl) ?? "RSS"} · ${parsed.items.length} recent items`,
    siteUrl: parsed.siteUrl,
    avatar: parsed.avatar,
  };
}

// ---------- Avatar proxy ----------

export function getNewsAvatarImage(sourceId: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const parsed = parseSourceId(sourceId);
  if (!parsed) return Promise.resolve(null);
  return cached(`news-avatar-bytes:${sourceId}`, AVATAR_TTL, async () => {
    let url: string | null = null;
    if (parsed.kind === "bsky") {
      const profile = await resolveBlueskyProfile(parsed.ref).catch(() => null);
      url = profile?.avatar ?? null;
    } else if (parsed.kind === "hn") {
      url = "https://news.ycombinator.com/y18.svg";
    } else {
      const domain = domainOf(parsed.ref);
      if (domain) url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
    }
    if (!url || !isSafeHttpUrl(url)) return null;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return null;
    return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") ?? "image/png" };
  });
}

// ---------- Helpers ----------

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#cdata"] === "string") return obj["#cdata"];
    if (typeof obj["#text"] === "string") return obj["#text"];
  }
  return "";
}

function firstHref(value: unknown): string {
  if (typeof value === "string") return safeUrl(value) ?? "";
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = firstHref(v);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["@_href"] === "string") return safeUrl(obj["@_href"]) ?? "";
    if (typeof obj.href === "string") return safeUrl(obj.href) ?? "";
  }
  return "";
}

function atomLink(value: unknown, rel: string): string {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of list) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const r = obj["@_rel"] ?? obj.rel;
      const href = obj["@_href"] ?? obj.href;
      if ((!r || r === rel) && typeof href === "string") {
        const ok = safeUrl(href);
        if (ok) return ok;
      }
    }
  }
  return "";
}

function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return isSafeHttpUrl(trimmed) ? trimmed : undefined;
}

function originOf(raw: string): string | undefined {
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

export function domainOf(raw: string): string | undefined {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function toIso(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

export function stripHtml(raw: string): string {
  return cleanText(
    decodeEntities(
      raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function headlineFrom(text: string): string {
  const cleaned = cleanText(text);
  if (cleaned.length <= 130) return cleaned;
  const firstSentence = cleaned.match(/^.{24,140}?[.!?](?=\s|$)/)?.[0];
  if (firstSentence) return firstSentence;
  return `${cleaned.slice(0, 128).trimEnd()}…`;
}
