import type { NewsItem } from "./types";

/**
 * Deterministic daily brief engine ($0, no LLM required).
 *
 * Groups items that cover the same real-world story (shared canonical URL or strong lexical overlap
 * across distinct sources) into "Key Events", extracts concise non-duplicate takeaways, and surfaces
 * substantive standalone posts/essays as "Key Insights".
 */

export type EventCluster = {
  id: string;
  headline: string;
  summary: string;
  takeaways: string[];
  latestAt: string;
  sources: { id: string; title: string }[];
  items: NewsItem[];
};

export type DailyBrief = {
  events: EventCluster[];
  insights: NewsItem[];
};

const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "have", "will", "are", "was", "were", "has",
  "had", "but", "not", "you", "your", "all", "can", "about", "into", "over", "after", "more", "out",
  "new", "says", "said", "say", "how", "why", "what", "when", "where", "who", "its", "their", "they",
  "them", "his", "her", "our", "been", "being", "than", "then", "also", "just", "only", "very",
  "most", "some", "many", "much", "such", "may", "might", "could", "would", "should", "now", "today",
  "here", "there", "report", "reports", "news", "update", "latest", "read", "watch", "post", "thread",
  "via", "from", "https", "http", "www", "com", "org", "net",
]);

type Prepared = {
  item: NewsItem;
  canonicalUrl: string | null;
  tokens: Set<string>;
  entities: Set<string>;
};

export function buildDailyBrief(items: NewsItem[]): DailyBrief {
  const ordered = [...items].sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || a.id.localeCompare(b.id));
  const prepared: Prepared[] = ordered.map((item) => ({
    item,
    canonicalUrl: canonicalizeUrl(item.url),
    tokens: tokenize(`${item.title} ${item.text.slice(0, 260)}`),
    entities: extractEntities(`${item.title} ${item.text.slice(0, 220)}`),
  }));

  // Single-linkage clustering with strict similarity threshold so unrelated posts never merge.
  const clusters: Prepared[][] = [];
  for (const entry of prepared) {
    let bestCluster: Prepared[] | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      // Only group stories within 36 hours of the cluster's newest post.
      const newest = Date.parse(cluster[0].item.published);
      const current = Date.parse(entry.item.published);
      if (Math.abs(newest - current) > 36 * 3_600_000) continue;

      let clusterMax = 0;
      for (const member of cluster) {
        const s = similarity(entry, member);
        if (s > clusterMax) clusterMax = s;
      }
      if (clusterMax > bestScore) {
        bestScore = clusterMax;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestScore >= 0.42) {
      bestCluster.push(entry);
    } else {
      clusters.push([entry]);
    }
  }

  const events: EventCluster[] = [];
  const singles: NewsItem[] = [];

  for (const group of clusters) {
    const distinctSources = uniqueSources(group.map((g) => g.item));
    // A "Key Event" has multiple distinct sources covering the same story (or 2+ posts on the exact same link).
    const sameLinkGroup = group.length >= 2 && group[0].canonicalUrl !== null && group.every((g) => g.canonicalUrl === group[0].canonicalUrl);
    if (distinctSources.length >= 2 || sameLinkGroup) {
      const clusterItems = group.map((g) => g.item);
      const lead = pickLead(clusterItems);
      const summary = cleanSummary(lead);
      const takeaways = buildTakeaways(clusterItems, lead);
      events.push({
        id: `event:${lead.id}`,
        headline: lead.title,
        summary,
        takeaways,
        latestAt: clusterItems[0].published,
        sources: distinctSources,
        items: clusterItems,
      });
    } else {
      // Collapse near-duplicate posts from the *same* source (keep the newest).
      singles.push(group[0].item);
    }
  }

  // Sort events by breadth (more distinct sources first), then recency.
  events.sort((a, b) => b.sources.length - a.sources.length || Date.parse(b.latestAt) - Date.parse(a.latestAt));

  // Insights: sort substantive items (essays, primary links, longer original analysis) gently while keeping recency dominant.
  const insights = [...singles].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));

  return { events, insights };
}

function similarity(a: Prepared, b: Prepared): number {
  if (a.canonicalUrl && b.canonicalUrl && a.canonicalUrl === b.canonicalUrl) return 1;
  if (!a.tokens.size || !b.tokens.size) return 0;

  let shared = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) shared++;
  if (shared < 2) return 0;

  let sharedEntities = 0;
  for (const e of a.entities) if (b.entities.has(e)) sharedEntities++;

  // Overlap coefficient (min-denominator) handles short headline + longer post well,
  // damped by Dice so tiny 2-word overlaps don't over-trigger.
  const dice = (2 * shared) / (a.tokens.size + b.tokens.size);
  const overlap = shared / Math.min(a.tokens.size, b.tokens.size);
  const entityBoost = sharedEntities >= 2 ? 0.2 : sharedEntities === 1 && shared >= 3 ? 0.1 : 0;

  // Require at least 3 shared words OR 2 shared named entities to prevent generic overlap.
  if (shared < 3 && sharedEntities < 2) return 0;
  return Math.min(1, dice * 0.55 + overlap * 0.45 + entityBoost);
}

function tokenize(text: string): Set<string> {
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/https?:\/\/\S+/gi, " ")
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g);
  const set = new Set<string>();
  if (!words) return set;
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    // Simple stem for common plurals so "tariffs" and "tariff" match.
    const stem = w.length > 5 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    set.add(stem);
  }
  return set;
}

function extractEntities(text: string): Set<string> {
  const cleaned = text.replace(/https?:\/\/\S+/gi, " ");
  const matches = cleaned.match(/\b(?:[A-Z][a-zA-Z0-9]{2,}|[A-Z]{2,}|[0-9]+(?:\.[0-9]+)?[%BMK]?)\b/g);
  const set = new Set<string>();
  if (!matches) return set;
  for (const m of matches) {
    const lower = m.toLowerCase();
    if (!STOPWORDS.has(lower) && lower.length >= 2) set.add(lower);
  }
  return set;
}

export function canonicalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    // Don't treat a bare social profile or post permalink as a shared external article URL.
    if (host === "bsky.app" || host === "news.ycombinator.com") return null;
    // Strip tracking query params.
    const kept = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|ref|source|fbclid|gclid|mc_|s$|si$)/i.test(k));
    const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${query}`;
  } catch {
    return null;
  }
}

function uniqueSources(items: NewsItem[]): { id: string; title: string }[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!seen.has(item.sourceId)) seen.set(item.sourceId, item.sourceTitle);
  }
  return [...seen].map(([id, title]) => ({ id, title }));
}

function pickLead(items: NewsItem[]): NewsItem {
  // Prefer a clean headline (40..120 chars) from an RSS/news desk or linked article over a truncated snippet.
  return [...items].sort((a, b) => leadScore(b) - leadScore(a))[0];
}

function leadScore(item: NewsItem): number {
  let score = 0;
  if (item.sourceKind === "rss") score += 2;
  if (item.title.length >= 35 && item.title.length <= 125 && !item.title.endsWith("…")) score += 2;
  if (item.text.length > item.title.length + 30) score += 1;
  return score;
}

function cleanSummary(item: NewsItem): string {
  const body = item.text.trim();
  if (!body || body.toLowerCase() === item.title.toLowerCase()) return "";
  // Drop the title prefix if the body repeats the headline verbatim.
  const withoutTitle = body.toLowerCase().startsWith(item.title.toLowerCase()) ? body.slice(item.title.length).replace(/^[\s:—–-]+/, "") : body;
  if (!withoutTitle) return "";
  const sentences = splitSentences(withoutTitle);
  const picked = sentences.slice(0, 2).join(" ");
  return picked.length > 240 ? `${picked.slice(0, 238).trimEnd()}…` : picked;
}

function buildTakeaways(items: NewsItem[], lead: NewsItem): string[] {
  const leadTokens = tokenize(`${lead.title} ${lead.text.slice(0, 200)}`);
  const out: string[] = [];
  const usedSources = new Set<string>([lead.sourceId]);

  for (const item of items) {
    if (usedSources.has(item.sourceId)) continue;
    const candidate = item.title.length >= 28 ? item.title : splitSentences(item.text)[0] ?? "";
    if (!candidate) continue;
    const tokens = tokenize(candidate);
    let overlap = 0;
    for (const t of tokens) if (leadTokens.has(t)) overlap++;
    // Only include as an extra bullet if it adds a genuinely new detail or angle.
    if (tokens.size > 0 && overlap / tokens.size < 0.72) {
      out.push(`${item.sourceTitle}: ${candidate.length > 140 ? `${candidate.slice(0, 138).trimEnd()}…` : candidate}`);
      usedSources.add(item.sourceId);
    }
    if (out.length >= 2) break;
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}
