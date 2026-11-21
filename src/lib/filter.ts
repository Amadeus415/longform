import type { Video } from "./types";

// The whole "algorithm". No ranking, no ML, no engagement signals: a video is shown unless one of
// your rules hides it, and the feed is sorted newest first. Same inputs, same feed, every time.

export type Rules = {
  /** Hide videos shorter than this many minutes. Videos of unknown length count as short. 0 = off. */
  minMinutes: number;
  /** Hide videos longer than this many minutes. 0 = off. */
  maxMinutes: number;
  /** Hide videos older than this many days. 0 = off. */
  maxAgeDays: number;
  /** Hide videos whose title contains any of these words or phrases. */
  hideWords: string[];
  /** ...unless the title also contains one of these. */
  allowWords: string[];
  /** Hide videos you have finished. */
  hideFinished: boolean;
};

export const DEFAULT_RULES: Rules = {
  minMinutes: 20,
  maxMinutes: 0,
  maxAgeDays: 0,
  hideWords: [
    "#shorts", "clip", "clips", "highlights", "reaction", "reacts", "prank", "compilation",
    "trailer", "teaser", "tiktok", "meme", "memes", "gameplay", "let's play", "unboxing",
    "asmr", "mukbang", "gone wrong",
  ],
  allowWords: [],
  hideFinished: true,
};

export type RuleKey = keyof Rules;
export type Verdict = { show: true } | { show: false; rule: RuleKey; reason: string };
export type Context = { now: number; finished: ReadonlySet<string> };
export type Hidden = { video: Video; rule: RuleKey; reason: string };

export function judge(video: Video, rules: Rules, { now, finished }: Context): Verdict {
  if (rules.hideFinished && finished.has(video.id)) {
    return { show: false, rule: "hideFinished", reason: "You finished it" };
  }
  if (rules.minMinutes > 0) {
    if (video.seconds === null) return { show: false, rule: "minMinutes", reason: "Length unknown (premiere or live)" };
    if (video.seconds < rules.minMinutes * 60) {
      return { show: false, rule: "minMinutes", reason: `Shorter than ${rules.minMinutes} min (${clock(video.seconds)})` };
    }
  }
  if (rules.maxMinutes > 0 && video.seconds !== null && video.seconds > rules.maxMinutes * 60) {
    return { show: false, rule: "maxMinutes", reason: `Longer than ${rules.maxMinutes} min (${clock(video.seconds)})` };
  }
  if (rules.maxAgeDays > 0) {
    const days = (now - Date.parse(video.published)) / 86_400_000;
    if (days > rules.maxAgeDays) {
      return { show: false, rule: "maxAgeDays", reason: `Older than ${rules.maxAgeDays} days` };
    }
  }
  const word = rules.hideWords.find((w) => contains(video.title, w));
  if (word && !rules.allowWords.some((w) => contains(video.title, w))) {
    return { show: false, rule: "hideWords", reason: `Title contains “${word}”` };
  }
  return { show: true };
}

export function applyRules(videos: Video[], rules: Rules, context: Context): { shown: Video[]; hidden: Hidden[] } {
  const shown: Video[] = [];
  const hidden: Hidden[] = [];
  const seen = new Set<string>();
  const sorted = [...videos].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  for (const video of sorted) {
    if (seen.has(video.id)) continue;
    seen.add(video.id);
    const verdict = judge(video, rules, context);
    if (verdict.show) shown.push(video);
    else hidden.push({ video, rule: verdict.rule, reason: verdict.reason });
  }
  return { shown, hidden };
}

/**
 * Whole-word, case-insensitive match. "clip" matches "Best clip" but not "eclipse".
 * A trailing * matches the start of a word: "react*" matches "reacts" and "reaction".
 */
export function contains(text: string, phrase: string): boolean {
  let needle = normalize(phrase);
  const prefix = needle.endsWith("*");
  if (prefix) needle = needle.slice(0, -1).trimEnd();
  if (!needle) return false;
  const haystack = normalize(text);
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    const before = haystack[i - 1];
    const after = haystack[i + needle.length];
    if (!isWordChar(before) && (prefix || !isWordChar(after))) return true;
  }
  return false;
}

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .trim();
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/** Describe what changed between two rule sets, one line per change. Used for the change history. */
export function describeChanges(before: Rules, after: Rules): string[] {
  const changes: string[] = [];
  const minutes = (n: number) => (n > 0 ? `${n} min` : "off");
  const days = (n: number) => (n > 0 ? `${n} days` : "off");
  if (before.minMinutes !== after.minMinutes) changes.push(`Shortest: ${minutes(before.minMinutes)} → ${minutes(after.minMinutes)}`);
  if (before.maxMinutes !== after.maxMinutes) changes.push(`Longest: ${minutes(before.maxMinutes)} → ${minutes(after.maxMinutes)}`);
  if (before.maxAgeDays !== after.maxAgeDays) changes.push(`Oldest: ${days(before.maxAgeDays)} → ${days(after.maxAgeDays)}`);
  for (const [key, label] of [["hideWords", "Hide"], ["allowWords", "Allow"]] as const) {
    const was = new Set(before[key]);
    const now = new Set(after[key]);
    const added = after[key].filter((w) => !was.has(w));
    const removed = before[key].filter((w) => !now.has(w));
    if (added.length) changes.push(`${label} + ${added.map((w) => `“${w}”`).join(", ")}`);
    if (removed.length) changes.push(`${label} − ${removed.map((w) => `“${w}”`).join(", ")}`);
  }
  if (before.hideFinished !== after.hideFinished) changes.push(`Hide finished: ${after.hideFinished ? "off → on" : "on → off"}`);
  return changes;
}

/** Accept rules from anywhere (storage, an imported file) and return a valid rule set. */
export function normalizeRules(input: unknown): Rules {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<RuleKey, unknown>>;
  const count = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
  const words = (value: unknown, fallback: string[]) =>
    Array.isArray(value) ? [...new Set(value.filter((w) => typeof w === "string").map((w) => w.trim()).filter(Boolean))] : fallback;
  return {
    minMinutes: count(raw.minMinutes, DEFAULT_RULES.minMinutes),
    maxMinutes: count(raw.maxMinutes, DEFAULT_RULES.maxMinutes),
    maxAgeDays: count(raw.maxAgeDays, DEFAULT_RULES.maxAgeDays),
    hideWords: words(raw.hideWords, DEFAULT_RULES.hideWords),
    allowWords: words(raw.allowWords, DEFAULT_RULES.allowWords),
    hideFinished: typeof raw.hideFinished === "boolean" ? raw.hideFinished : DEFAULT_RULES.hideFinished,
  };
}
