import { contains } from "./filter";
import type { NewsItem } from "./types";

// Deterministic news filter, mirroring filter.ts:
// No engagement ranking, no black box. Every hidden post has a one-line reason.

export type NewsRules = {
  /** Hide items older than this many hours. 0 = off. */
  maxAgeHours: number;
  /** Hide short social posts under this many characters (links/articles exempt if they carry a title). 0 = off. */
  minChars: number;
  /** Hide reposts / boosts to cut echo chambers. */
  hideReposts: boolean;
  /** Hide replies to other people. */
  hideReplies: boolean;
  /** Hide items whose title or text contains any of these words or phrases. */
  hideWords: string[];
  /** ...unless it also contains one of these. */
  allowWords: string[];
  /** Hide items you have already marked read. */
  hideRead: boolean;
};

export const DEFAULT_NEWS_RULES: NewsRules = {
  maxAgeHours: 24,
  minChars: 40,
  hideReposts: true,
  hideReplies: true,
  hideWords: [
    "unpopular opinion",
    "hot take",
    "giveaway",
    "sponsored",
    "promo code",
    "you won't believe",
    "wordle",
    "retweet to",
    "repost to",
  ],
  allowWords: [],
  hideRead: true,
};

export type NewsRuleKey = keyof NewsRules;
export type NewsVerdict = { show: true } | { show: false; rule: NewsRuleKey; reason: string };
export type NewsContext = { now: number; read: ReadonlySet<string> };
export type HiddenNews = { item: NewsItem; rule: NewsRuleKey; reason: string };

export function judgeNews(item: NewsItem, rules: NewsRules, { now, read }: NewsContext): NewsVerdict {
  if (rules.hideRead && read.has(item.id)) {
    return { show: false, rule: "hideRead", reason: "You already read it" };
  }
  if (rules.hideReposts && item.isRepost) {
    return { show: false, rule: "hideReposts", reason: "Repost" };
  }
  if (rules.hideReplies && item.isReply) {
    return { show: false, rule: "hideReplies", reason: "Reply" };
  }
  if (rules.maxAgeHours > 0) {
    const hours = (now - Date.parse(item.published)) / 3_600_000;
    if (hours > rules.maxAgeHours) {
      return { show: false, rule: "maxAgeHours", reason: `Older than ${hoursLabel(rules.maxAgeHours)}` };
    }
  }
  if (rules.minChars > 0) {
    const bodyLen = Math.max(item.title.length, item.text.length);
    if (bodyLen < rules.minChars) {
      return { show: false, rule: "minChars", reason: `Shorter than ${rules.minChars} chars (${bodyLen})` };
    }
  }
  const combined = `${item.title} ${item.text}`;
  const word = rules.hideWords.find((w) => contains(combined, w));
  if (word && !rules.allowWords.some((w) => contains(combined, w))) {
    return { show: false, rule: "hideWords", reason: `Contains “${word}”` };
  }
  return { show: true };
}

export function applyNewsRules(items: NewsItem[], rules: NewsRules, context: NewsContext): { shown: NewsItem[]; hidden: HiddenNews[] } {
  const shown: NewsItem[] = [];
  const hidden: HiddenNews[] = [];
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || a.id.localeCompare(b.id));
  for (const item of sorted) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const verdict = judgeNews(item, rules, context);
    if (verdict.show) shown.push(item);
    else hidden.push({ item, rule: verdict.rule, reason: verdict.reason });
  }
  return { shown, hidden };
}

export function hoursLabel(hours: number): string {
  if (hours <= 0) return "Off";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "24 hours" : `${days} days`;
  }
  return `${hours} hours`;
}

export function describeNewsChanges(before: NewsRules, after: NewsRules): string[] {
  const changes: string[] = [];
  if (before.maxAgeHours !== after.maxAgeHours) changes.push(`Window: ${hoursLabel(before.maxAgeHours)} → ${hoursLabel(after.maxAgeHours)}`);
  const chars = (n: number) => (n > 0 ? `${n} chars` : "off");
  if (before.minChars !== after.minChars) changes.push(`Shortest: ${chars(before.minChars)} → ${chars(after.minChars)}`);
  if (before.hideReposts !== after.hideReposts) changes.push(`Hide reposts: ${after.hideReposts ? "off → on" : "on → off"}`);
  if (before.hideReplies !== after.hideReplies) changes.push(`Hide replies: ${after.hideReplies ? "off → on" : "on → off"}`);
  for (const [key, label] of [["hideWords", "Hide"], ["allowWords", "Allow"]] as const) {
    const was = new Set(before[key]);
    const now = new Set(after[key]);
    const added = after[key].filter((w) => !was.has(w));
    const removed = before[key].filter((w) => !now.has(w));
    if (added.length) changes.push(`${label} + ${added.map((w) => `“${w}”`).join(", ")}`);
    if (removed.length) changes.push(`${label} − ${removed.map((w) => `“${w}”`).join(", ")}`);
  }
  if (before.hideRead !== after.hideRead) changes.push(`Hide read: ${after.hideRead ? "off → on" : "on → off"}`);
  return changes;
}

export function normalizeNewsRules(input: unknown): NewsRules {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<NewsRuleKey, unknown>>;
  const count = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const words = (value: unknown, fallback: string[]) =>
    Array.isArray(value) ? [...new Set(value.filter((w) => typeof w === "string").map((w) => w.trim()).filter(Boolean))] : fallback;
  return {
    maxAgeHours: count(raw.maxAgeHours, DEFAULT_NEWS_RULES.maxAgeHours),
    minChars: count(raw.minChars, DEFAULT_NEWS_RULES.minChars),
    hideReposts: bool(raw.hideReposts, DEFAULT_NEWS_RULES.hideReposts),
    hideReplies: bool(raw.hideReplies, DEFAULT_NEWS_RULES.hideReplies),
    hideWords: words(raw.hideWords, DEFAULT_NEWS_RULES.hideWords),
    allowWords: words(raw.allowWords, DEFAULT_NEWS_RULES.allowWords),
    hideRead: bool(raw.hideRead, DEFAULT_NEWS_RULES.hideRead),
  };
}
