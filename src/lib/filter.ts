import { analyzeClickbait, buildTasteProfile, computePersonalScore, type TasteProfile } from "./personalize";
import type { LlmJudgment, PersonalScore, Video, VideoRating } from "./types";

// Two-stage transparent feed filter:
// 1. Light deterministic rules remove Shorts, finished videos, blocked channels, old items (Following only),
//    and ultra-high-precision slop phrases.
// 2. A server-cached canonical Gemini educational judge scores survivors, personalized on-device by your 1–10 ratings.
//    - Discover videos fail CLOSED (wait in `pending` until scored) whenever the AI judge is enabled,
//      including while server status is still loading (`judgeAvailable === null`).
//    - Followed channels default to untouched unless you opt into AI filtering for "all" videos.

export type LlmJudgeScope = "discover" | "all";

export type LlmJudgeRules = {
  /** Whether the LLM educational judge is enabled. */
  enabled: boolean;
  /** Minimum educational/signal score (1–10) required to appear in feed. */
  minScore: number;
  /** Always hide videos flagged as brainrot/clickbait/slop regardless of score. */
  hideBrainrot: boolean;
  /** Apply to recommended ("discover") videos only, or "all" videos including followed channels. */
  scope: LlmJudgeScope;
  /** Plain-English rubric guidance for the LLM judge. */
  prompt: string;
};

export type Rules = {
  /** Hide videos shorter than this many minutes. 0 = off. */
  minMinutes: number;
  /** Hide videos longer than this many minutes. 0 = off. */
  maxMinutes: number;
  /** Hide followed videos older than this many days (Discover is exempt so evergreen lectures survive). 0 = off. */
  maxAgeDays: number;
  /** Maximum videos shown per followed channel in the main feed (0 = unlimited). */
  maxPerChannel: number;
  /** Hide videos whose title contains any of these unambiguous slop phrases. */
  hideWords: string[];
  /** ...unless the title also contains one of these. */
  allowWords: string[];
  /** Hide videos you have finished. */
  hideFinished: boolean;
  /** Blend a calm daily edition of recommended videos from unfollowed channels into your feed. */
  discoverEnabled: boolean;
  /** Maximum number of recommended videos in your daily Discover edition. */
  discoverLimit: number;
  /** Optional soft daily listening/watching budget in minutes (0 = off). */
  dailyBudgetMinutes: number;
  /** Optional Gemini LLM educational judge settings. */
  llm: LlmJudgeRules;
};

export const CANONICAL_RUBRIC_VERSION = "canonical:v2";

export const DEFAULT_LLM_PROMPT =
  "Keep genuinely educational, insightful, technical, scientific, historical, business, or deeply informative videos (including concise 4–19 min explainers). Hide brainrot, ragebait, celebrity/influencer drama, shallow listicles, clickbait stunts, and mindless entertainment.";

export const DEFAULT_LLM_RULES: LlmJudgeRules = {
  enabled: true,
  minScore: 6,
  hideBrainrot: true,
  scope: "discover",
  prompt: DEFAULT_LLM_PROMPT,
};

/**
 * Ultra-high-precision default hide phrases that target ONLY unambiguous slop/Shorts.
 * Never blocks educational titles like "How your body reacts to extreme cold",
 * "How compilation works in Rust", "How TikTok's recommendation algorithm works",
 * "ASMR and the science of tingles", "Unboxing the James Webb mirror design",
 * or "The prank that fooled Victorian London".
 */
export const DEFAULT_HIDE_WORDS: string[] = [
  "#shorts",
  "reaction video",
  "mukbang",
  "try not to laugh",
  "drama alert",
  "prank gone wrong",
  "cringe compilation",
  "fails compilation",
  "tiktok compilation",
  "tiktok trends",
  "asmr eating",
  "unboxing haul",
];

export const DEFAULT_RULES: Rules = {
  minMinutes: 3,
  maxMinutes: 0,
  maxAgeDays: 30,
  maxPerChannel: 2,
  hideWords: DEFAULT_HIDE_WORDS,
  allowWords: [],
  hideFinished: true,
  discoverEnabled: true,
  discoverLimit: 6,
  dailyBudgetMinutes: 0,
  llm: DEFAULT_LLM_RULES,
};

export type RuleKey =
  | "minMinutes"
  | "maxMinutes"
  | "maxAgeDays"
  | "hideWords"
  | "allowWords"
  | "hideFinished"
  | "llm"
  | "blockedChannel"
  | "channelCap"
  | "discoverCap"
  | "pending";

export type Verdict =
  | { show: true; pending?: false; judgment?: LlmJudgment; personal?: PersonalScore }
  | { show: false; pending: true; rule: "pending"; reason: string }
  | { show: false; pending?: false; rule: RuleKey; reason: string; judgment?: LlmJudgment; personal?: PersonalScore };

export type Context = {
  now: number;
  finished: ReadonlySet<string>;
  judgments?: Readonly<Record<string, LlmJudgment>>;
  blockedChannels?: ReadonlySet<string>;
  /** Lowercased blocked channel titles, for fallback matching when a recommendation lacks a channelId. */
  blockedChannelNames?: ReadonlySet<string>;
  /** User's 1–10 ratings for deterministic on-device score personalization. */
  ratings?: Readonly<Record<string, VideoRating>>;
  /** Optional precomputed TasteProfile (avoids recomputing per video). */
  tasteProfile?: TasteProfile;
  /** Whether the server AI judge is known to be available (true / false / null = checking). */
  judgeAvailable?: boolean | null;
  /** Fail-closed for unjudged Discover videos when AI judge is enabled (default true). */
  failClosedDiscover?: boolean;
  /** Only set true during unsaved custom-prompt draft previews in Algorithm.tsx. */
  allowCanonicalFallback?: boolean;
};

export type Hidden = {
  video: Video;
  rule: RuleKey;
  reason: string;
  judgment?: LlmJudgment;
  personal?: PersonalScore;
};

function normalizePromptText(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isDefaultPrompt(prompt: string): boolean {
  return normalizePromptText(prompt) === normalizePromptText(DEFAULT_LLM_PROMPT);
}

/** Deterministic, cross-runtime (browser + Node) short hash of the LLM rubric prompt. */
export function rubricHash(prompt: string): string {
  const clean = normalizePromptText(prompt);
  if (clean === normalizePromptText(DEFAULT_LLM_PROMPT)) {
    return CANONICAL_RUBRIC_VERSION;
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export function judgmentKey(videoId: string, hash: string): string {
  return `${videoId}:${hash}`;
}

/**
 * Look up a video's judgment for the active rubric.
 * Strictly matches `rubricHash(rules.llm.prompt)` so custom rubrics are NEVER shadowed by canonical scores
 * (pass `allowCanonicalFallback = true` ONLY when rendering an unsaved custom-prompt preview).
 */
export function lookupJudgment(
  videoId: string,
  rules: Rules,
  judgments?: Readonly<Record<string, LlmJudgment>>,
  allowCanonicalFallback = false,
): LlmJudgment | undefined {
  if (!judgments) return undefined;
  const hash = rubricHash(rules.llm.prompt);
  const exact =
    judgments[judgmentKey(videoId, hash)] ??
    (judgments[videoId]?.rubricHash === hash ? judgments[videoId] : undefined);
  if (exact) return exact;
  if (allowCanonicalFallback) {
    return judgments[judgmentKey(videoId, CANONICAL_RUBRIC_VERSION)];
  }
  return undefined;
}

/** Whether a video should be evaluated by the LLM judge under the current rules. */
export function needsLlmJudge(video: Video, rules: Rules): boolean {
  if (!rules.llm.enabled) return false;
  if (rules.llm.scope === "all") return true;
  return video.source === "discover";
}

function isChannelBlocked(video: Video, context: Context): boolean {
  if (video.channelId && context.blockedChannels?.has(video.channelId)) return true;
  if (video.channel && context.blockedChannelNames?.has(video.channel.trim().toLowerCase())) return true;
  return false;
}

/** Run ONLY the fast, deterministic filter layer (before LLM judgment). */
export function judgeDeterministic(video: Video, rules: Rules, context: Context): Verdict {
  const { now, finished } = context;

  if (isChannelBlocked(video, context)) {
    return { show: false, rule: "blockedChannel", reason: `Hidden channel (${video.channel})` };
  }
  if (rules.hideFinished && finished.has(video.id)) {
    return { show: false, rule: "hideFinished", reason: "You finished it" };
  }
  if (rules.minMinutes > 0) {
    if (video.seconds === null) {
      // Never silently wipe out a followed channel's UULF long-form uploads if YouTube's
      // length lookup was temporarily rate-limited; UULF already excludes Shorts & live streams.
      if (!video.fromLongFormFeed) {
        return { show: false, rule: "minMinutes", reason: "Length unknown (premiere or live)" };
      }
    } else if (video.seconds < rules.minMinutes * 60) {
      return { show: false, rule: "minMinutes", reason: `Shorter than ${rules.minMinutes} min (${clock(video.seconds)})` };
    }
  }
  if (rules.maxMinutes > 0 && video.seconds !== null && video.seconds > rules.maxMinutes * 60) {
    return { show: false, rule: "maxMinutes", reason: `Longer than ${rules.maxMinutes} min (${clock(video.seconds)})` };
  }
  // Apply `maxAgeDays` to Followed channels only so timeless evergreen Discover lectures survive!
  if (rules.maxAgeDays > 0 && video.source !== "discover" && video.published) {
    const publishedMs = Date.parse(video.published);
    if (Number.isFinite(publishedMs)) {
      const days = (now - publishedMs) / 86_400_000;
      if (days > rules.maxAgeDays) {
        return { show: false, rule: "maxAgeDays", reason: `Older than ${rules.maxAgeDays} days` };
      }
    }
  }
  const word = rules.hideWords.find((w) => contains(video.title, w));
  if (word && !rules.allowWords.some((w) => contains(video.title, w))) {
    return { show: false, rule: "hideWords", reason: `Title contains “${word}”` };
  }
  return { show: true };
}

export function judge(video: Video, rules: Rules, context: Context): Verdict {
  const det = judgeDeterministic(video, rules, context);
  if (!det.show) return det;

  const isDiscover = video.source === "discover";
  const shouldJudge = needsLlmJudge(video, rules);

  if (shouldJudge) {
    const j = lookupJudgment(video.id, rules, context.judgments, Boolean(context.allowCanonicalFallback));
    if (j) {
      const profile = context.tasteProfile ?? buildTasteProfile(context.ratings);
      const directRating = context.ratings?.[video.id];
      const personal = computePersonalScore(video, j, profile, directRating);
      const effective = personal.effectiveScore;

      // If user explicitly rated this video >= minScore, let their rating rescue it.
      if (personal.isDirectRating && effective >= rules.llm.minScore) {
        return { show: true, judgment: j, personal };
      }

      if (rules.llm.hideBrainrot && j.brainrot) {
        return {
          show: false,
          rule: "llm",
          reason: `AI (${j.score}/10 · brainrot): ${j.reason}`,
          judgment: j,
          personal,
        };
      }
      if (effective < rules.llm.minScore) {
        const deltaNote =
          personal.delta !== 0
            ? ` → ${effective.toFixed(1)}/10 (${personal.breakdown.slice(0, 2).join(", ")})`
            : "";
        return {
          show: false,
          rule: "llm",
          reason: `AI (${j.score}/10${deltaNote} < ${rules.llm.minScore}): ${j.reason}`,
          judgment: j,
          personal,
        };
      }
      return { show: true, judgment: j, personal };
    }

    // Unjudged Discover video handling:
    // ALWAYS fail CLOSED when AI judge is enabled — including while `judgeAvailable` is `null` or `undefined`!
    const failClosed = context.failClosedDiscover ?? true;
    if (isDiscover && failClosed) {
      if (context.judgeAvailable === false) {
        const cb = analyzeClickbait(video.title);
        if (cb.risk >= 3.5) {
          return {
            show: false,
            rule: "llm",
            reason: `Clickbait guard (${cb.signals.slice(0, 2).join(", ")})`,
          };
        }
        return {
          show: false,
          pending: true,
          rule: "pending",
          reason: "AI judge unavailable (set GEMINI_API_KEY or turn off AI judge to browse with the clickbait guard)",
        };
      }
      // Covers both `judgeAvailable === true` AND `judgeAvailable === null/undefined` (startup / checking).
      return {
        show: false,
        pending: true,
        rule: "pending",
        reason: "Waiting for AI educational score…",
      };
    }
  }

  // Zero-key safety net: even if AI judge is explicitly turned off, protect Discover from clickbait & ragebait slop.
  if (isDiscover && !rules.llm.enabled) {
    const cb = analyzeClickbait(video.title);
    if (cb.risk >= 3.5) {
      return {
        show: false,
        rule: "hideWords",
        reason: `Clickbait guard (${cb.signals.slice(0, 2).join(", ")})`,
      };
    }
  }

  return { show: true };
}

export type ApplyResult = {
  shown: Video[];
  hidden: Hidden[];
  pending: Hidden[];
  /** Number of additional videos per channel trimmed by `maxPerChannel`. */
  channelOverflow: Record<string, number>;
};

export function applyRules(videos: Video[], rules: Rules, context: Context): ApplyResult {
  const shown: Video[] = [];
  const hidden: Hidden[] = [];
  const pending: Hidden[] = [];
  const channelOverflow: Record<string, number> = {};
  const seen = new Set<string>();
  const channelCounts = new Map<string, number>();

  const enrichedContext: Context =
    context.tasteProfile || !context.ratings
      ? context
      : { ...context, tasteProfile: buildTasteProfile(context.ratings) };

  const sorted = [...videos].sort((a, b) => {
    const ta = a.published ? Date.parse(a.published) || 0 : 0;
    const tb = b.published ? Date.parse(b.published) || 0 : 0;
    return tb - ta;
  });

  for (const video of sorted) {
    if (seen.has(video.id)) continue;
    seen.add(video.id);
    const verdict = judge(video, rules, enrichedContext);
    if (verdict.show) {
      if (rules.maxPerChannel > 0 && video.source !== "discover") {
        const chKey = video.channelId || video.channel || video.id;
        const count = channelCounts.get(chKey) ?? 0;
        if (count >= rules.maxPerChannel) {
          channelOverflow[chKey] = (channelOverflow[chKey] ?? 0) + 1;
          hidden.push({
            video,
            rule: "channelCap",
            reason: `More than ${rules.maxPerChannel} from ${video.channel}`,
            judgment: verdict.judgment,
            personal: verdict.personal,
          });
          continue;
        }
        channelCounts.set(chKey, count + 1);
      }
      shown.push(video);
    } else if (verdict.pending) {
      pending.push({ video, rule: "pending", reason: verdict.reason });
    } else {
      hidden.push({
        video,
        rule: verdict.rule,
        reason: verdict.reason,
        judgment: verdict.judgment,
        personal: verdict.personal,
      });
    }
  }
  return { shown, hidden, pending, channelOverflow };
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
  const cap = (n: number) => (n > 0 ? `${n}/channel` : "off");
  if (before.minMinutes !== after.minMinutes) changes.push(`Shortest: ${minutes(before.minMinutes)} → ${minutes(after.minMinutes)}`);
  if (before.maxMinutes !== after.maxMinutes) changes.push(`Longest: ${minutes(before.maxMinutes)} → ${minutes(after.maxMinutes)}`);
  if (before.maxAgeDays !== after.maxAgeDays) changes.push(`Oldest: ${days(before.maxAgeDays)} → ${days(after.maxAgeDays)}`);
  if (before.maxPerChannel !== after.maxPerChannel) changes.push(`Channel cap: ${cap(before.maxPerChannel)} → ${cap(after.maxPerChannel)}`);
  for (const [key, label] of [["hideWords", "Hide"], ["allowWords", "Allow"]] as const) {
    const was = new Set(before[key]);
    const now = new Set(after[key]);
    const added = after[key].filter((w) => !was.has(w));
    const removed = before[key].filter((w) => !now.has(w));
    if (added.length) changes.push(`${label} + ${added.map((w) => `“${w}”`).join(", ")}`);
    if (removed.length) changes.push(`${label} − ${removed.map((w) => `“${w}”`).join(", ")}`);
  }
  if (before.hideFinished !== after.hideFinished) changes.push(`Hide finished: ${after.hideFinished ? "off → on" : "on → off"}`);
  if (before.discoverEnabled !== after.discoverEnabled) changes.push(`Recommendations: ${after.discoverEnabled ? "off → on" : "on → off"}`);
  if (before.discoverLimit !== after.discoverLimit) changes.push(`Daily Discover cap: ${before.discoverLimit} → ${after.discoverLimit}`);
  if (before.dailyBudgetMinutes !== after.dailyBudgetMinutes) {
    changes.push(`Daily budget: ${minutes(before.dailyBudgetMinutes)} → ${minutes(after.dailyBudgetMinutes)}`);
  }
  if (before.llm.enabled !== after.llm.enabled) changes.push(`AI judge: ${after.llm.enabled ? "off → on" : "on → off"}`);
  if (before.llm.minScore !== after.llm.minScore) changes.push(`AI min score: ${before.llm.minScore}/10 → ${after.llm.minScore}/10`);
  if (before.llm.hideBrainrot !== after.llm.hideBrainrot) changes.push(`Block brainrot: ${after.llm.hideBrainrot ? "off → on" : "on → off"}`);
  if (before.llm.scope !== after.llm.scope) changes.push(`AI scope: ${before.llm.scope} → ${after.llm.scope}`);
  if (before.llm.prompt.trim() !== after.llm.prompt.trim()) changes.push("Updated AI judge prompt");
  return changes;
}

/** Accept rules from anywhere (storage, an imported file) and return a valid rule set. */
export function normalizeRules(input: unknown): Rules {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof Rules, unknown>>;
  const count = (value: unknown, fallback: number, min = 0, max = 10_000) =>
    typeof value === "number" && Number.isFinite(value) && value >= min ? Math.min(max, Math.round(value)) : fallback;
  const words = (value: unknown, fallback: string[]) =>
    Array.isArray(value) ? [...new Set(value.filter((w) => typeof w === "string").map((w) => w.trim()).filter(Boolean))] : fallback;

  const rawLlm = (raw.llm && typeof raw.llm === "object" ? raw.llm : {}) as Partial<Record<keyof LlmJudgeRules, unknown>>;
  const llm: LlmJudgeRules = {
    enabled: typeof rawLlm.enabled === "boolean" ? rawLlm.enabled : DEFAULT_LLM_RULES.enabled,
    minScore: count(rawLlm.minScore, DEFAULT_LLM_RULES.minScore, 1, 10),
    hideBrainrot: typeof rawLlm.hideBrainrot === "boolean" ? rawLlm.hideBrainrot : DEFAULT_LLM_RULES.hideBrainrot,
    scope: rawLlm.scope === "discover" || rawLlm.scope === "all" ? rawLlm.scope : DEFAULT_LLM_RULES.scope,
    prompt: typeof rawLlm.prompt === "string" && rawLlm.prompt.trim() ? rawLlm.prompt.trim().slice(0, 1200) : DEFAULT_LLM_RULES.prompt,
  };

  return {
    minMinutes: count(raw.minMinutes, DEFAULT_RULES.minMinutes),
    maxMinutes: count(raw.maxMinutes, DEFAULT_RULES.maxMinutes),
    maxAgeDays: count(raw.maxAgeDays, DEFAULT_RULES.maxAgeDays),
    maxPerChannel: count(raw.maxPerChannel, DEFAULT_RULES.maxPerChannel, 0, 50),
    hideWords: words(raw.hideWords, DEFAULT_RULES.hideWords),
    allowWords: words(raw.allowWords, DEFAULT_RULES.allowWords),
    hideFinished: typeof raw.hideFinished === "boolean" ? raw.hideFinished : DEFAULT_RULES.hideFinished,
    discoverEnabled: typeof raw.discoverEnabled === "boolean" ? raw.discoverEnabled : DEFAULT_RULES.discoverEnabled,
    discoverLimit: count(raw.discoverLimit, DEFAULT_RULES.discoverLimit, 1, 30),
    dailyBudgetMinutes: count(raw.dailyBudgetMinutes, DEFAULT_RULES.dailyBudgetMinutes, 0, 600),
    llm,
  };
}
