import type { CalibrationExample, VideoRating } from "./types";

const MAX_RATINGS = 2500;

export function normalizeRatingScore(score: unknown): number | null {
  const n = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 10) return null;
  return rounded;
}

export function sanitizeRating(raw: unknown, fallbackVideoId?: string): VideoRating | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const videoId = typeof r.videoId === "string" && r.videoId.trim() ? r.videoId.trim().slice(0, 64) : (fallbackVideoId ?? "").trim().slice(0, 64);
  if (!videoId) return null;
  const score = normalizeRatingScore(r.score);
  if (score === null) return null;
  const ratedAt = typeof r.ratedAt === "number" && Number.isFinite(r.ratedAt) && r.ratedAt > 0 ? Math.round(r.ratedAt) : Date.now();
  const title = typeof r.title === "string" ? r.title.trim().slice(0, 220) : "";
  const channel = typeof r.channel === "string" ? r.channel.trim().slice(0, 120) : "";
  const channelId = typeof r.channelId === "string" ? r.channelId.trim().slice(0, 64) : "";
  const published = typeof r.published === "string" && r.published.trim() ? r.published.trim().slice(0, 64) : undefined;
  const seconds = typeof r.seconds === "number" && Number.isFinite(r.seconds) && r.seconds >= 0 ? Math.round(r.seconds) : null;
  const source = r.source === "discover" || r.source === "following" ? r.source : undefined;
  const note = typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 280) : undefined;
  const aiScore = normalizeRatingScore(r.aiScore) ?? undefined;
  const aiBrainrot = typeof r.aiBrainrot === "boolean" ? r.aiBrainrot : undefined;
  const aiCategory = typeof r.aiCategory === "string" && r.aiCategory.trim() ? r.aiCategory.trim().slice(0, 48) : undefined;
  const aiReason = typeof r.aiReason === "string" && r.aiReason.trim() ? r.aiReason.trim().slice(0, 180) : undefined;

  return {
    videoId,
    score,
    ratedAt,
    ...(note ? { note } : {}),
    title,
    channel,
    channelId,
    ...(published ? { published } : {}),
    seconds,
    ...(source ? { source } : {}),
    ...(aiScore !== undefined ? { aiScore } : {}),
    ...(aiBrainrot !== undefined ? { aiBrainrot } : {}),
    ...(aiCategory ? { aiCategory } : {}),
    ...(aiReason ? { aiReason } : {}),
  };
}

export function sanitizeRatingsMap(raw: unknown): Record<string, VideoRating> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries: [string, VideoRating][] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const clean = sanitizeRating(value, key);
    if (clean) entries.push([clean.videoId, clean]);
  }
  if (entries.length > MAX_RATINGS) {
    entries.sort((a, b) => b[1].ratedAt - a[1].ratedAt);
    return Object.fromEntries(entries.slice(0, MAX_RATINGS));
  }
  return Object.fromEntries(entries);
}

export type GroupStat = {
  key: string;
  label: string;
  count: number;
  avgScore: number;
  aiAvgScore: number | null;
};

export type AiDisagreement = {
  rating: VideoRating;
  /** userScore - aiScore (positive means you liked it more than AI predicted; negative means AI overrated it) */
  delta: number;
};

export type RatingsSummary = {
  count: number;
  avgScore: number;
  highCount: number; // 8-10
  midCount: number; // 5-7
  lowCount: number; // 1-4
  /** Counts for scores 1 through 10 (index 0 = score 1, index 9 = score 10). */
  distribution: number[];
  bySource: {
    following: { count: number; avgScore: number | null };
    discover: { count: number; avgScore: number | null };
  };
  byChannel: GroupStat[];
  byCategory: GroupStat[];
  byLength: GroupStat[];
  aiAlignment: {
    pairedCount: number;
    avgHuman: number | null;
    avgAi: number | null;
    meanAbsError: number | null;
    /** avgAi - avgHuman (positive = AI tends to score higher than you) */
    bias: number | null;
    disagreements: AiDisagreement[];
  };
};

function avg(nums: number[]): number {
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : 0;
}

const LENGTH_BUCKETS: { key: string; label: string; fits: (s: number) => boolean }[] = [
  { key: "concise", label: "Under 20m", fits: (s) => s < 1200 },
  { key: "short", label: "20–60m", fits: (s) => s >= 1200 && s < 3600 },
  { key: "mid", label: "1–2 hr", fits: (s) => s >= 3600 && s < 7200 },
  { key: "long", label: "2 hr+", fits: (s) => s >= 7200 },
];

export function summarizeRatings(ratings: Record<string, VideoRating>): RatingsSummary {
  const list = Object.values(ratings);
  const distribution = Array<number>(10).fill(0);
  const scores: number[] = [];
  let highCount = 0;
  let midCount = 0;
  let lowCount = 0;

  const followingScores: number[] = [];
  const discoverScores: number[] = [];

  const channels = new Map<string, { label: string; scores: number[]; aiScores: number[] }>();
  const categories = new Map<string, { label: string; scores: number[]; aiScores: number[] }>();
  const lengths = new Map<string, { label: string; scores: number[]; aiScores: number[] }>();
  for (const b of LENGTH_BUCKETS) lengths.set(b.key, { label: b.label, scores: [], aiScores: [] });

  const pairedHuman: number[] = [];
  const pairedAi: number[] = [];
  const absErrors: number[] = [];
  const disagreements: AiDisagreement[] = [];

  for (const r of list) {
    const s = Math.max(1, Math.min(10, Math.round(r.score)));
    distribution[s - 1]++;
    scores.push(s);
    if (s >= 8) highCount++;
    else if (s >= 5) midCount++;
    else lowCount++;

    if (r.source === "discover") discoverScores.push(s);
    else followingScores.push(s);

    const chKey = r.channelId || r.channel || "unknown";
    const chEntry = channels.get(chKey) ?? { label: r.channel || "Unknown channel", scores: [], aiScores: [] };
    chEntry.scores.push(s);
    if (typeof r.aiScore === "number") chEntry.aiScores.push(r.aiScore);
    channels.set(chKey, chEntry);

    if (r.aiCategory) {
      const catKey = r.aiCategory.trim();
      const catEntry = categories.get(catKey) ?? { label: catKey, scores: [], aiScores: [] };
      catEntry.scores.push(s);
      if (typeof r.aiScore === "number") catEntry.aiScores.push(r.aiScore);
      categories.set(catKey, catEntry);
    }

    if (typeof r.seconds === "number" && r.seconds > 0) {
      const bucket = LENGTH_BUCKETS.find((b) => b.fits(r.seconds!));
      if (bucket) {
        const lenEntry = lengths.get(bucket.key)!;
        lenEntry.scores.push(s);
        if (typeof r.aiScore === "number") lenEntry.aiScores.push(r.aiScore);
      }
    }

    if (typeof r.aiScore === "number") {
      pairedHuman.push(s);
      pairedAi.push(r.aiScore);
      const delta = s - r.aiScore;
      absErrors.push(Math.abs(delta));
      if (Math.abs(delta) >= 2) {
        disagreements.push({ rating: r, delta });
      }
    }
  }

  const toStats = (map: Map<string, { label: string; scores: number[]; aiScores: number[] }>): GroupStat[] =>
    [...map.entries()]
      .filter(([, v]) => v.scores.length > 0)
      .map(([key, v]) => ({
        key,
        label: v.label,
        count: v.scores.length,
        avgScore: avg(v.scores),
        aiAvgScore: v.aiScores.length ? avg(v.aiScores) : null,
      }))
      .sort((a, b) => b.avgScore - a.avgScore || b.count - a.count || a.label.localeCompare(b.label));

  disagreements.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.rating.ratedAt - a.rating.ratedAt);

  const avgHuman = pairedHuman.length ? avg(pairedHuman) : null;
  const avgAi = pairedAi.length ? avg(pairedAi) : null;

  return {
    count: list.length,
    avgScore: avg(scores),
    highCount,
    midCount,
    lowCount,
    distribution,
    bySource: {
      following: { count: followingScores.length, avgScore: followingScores.length ? avg(followingScores) : null },
      discover: { count: discoverScores.length, avgScore: discoverScores.length ? avg(discoverScores) : null },
    },
    byChannel: toStats(channels),
    byCategory: toStats(categories),
    byLength: LENGTH_BUCKETS.map((b) => {
      const v = lengths.get(b.key)!;
      return {
        key: b.key,
        label: b.label,
        count: v.scores.length,
        avgScore: avg(v.scores),
        aiAvgScore: v.aiScores.length ? avg(v.aiScores) : null,
      };
    }).filter((x) => x.count > 0),
    aiAlignment: {
      pairedCount: pairedHuman.length,
      avgHuman,
      avgAi,
      meanAbsError: absErrors.length ? avg(absErrors) : null,
      bias: avgHuman !== null && avgAi !== null ? Math.round((avgAi - avgHuman) * 10) / 10 : null,
      disagreements,
    },
  };
}

/**
 * Pick a balanced set of rated videos to calibrate the Gemini AI judge:
 * biggest AI-vs-human disagreements first, plus recent favorites (8-10) and misses (1-4).
 */
export function buildCalibrationExamples(ratings: Record<string, VideoRating>, limit = 12): CalibrationExample[] {
  const list = Object.values(ratings).sort((a, b) => b.ratedAt - a.ratedAt);
  if (!list.length || limit <= 0) return [];

  const picked: VideoRating[] = [];
  const seen = new Set<string>();
  const take = (items: VideoRating[], max: number) => {
    let added = 0;
    for (const r of items) {
      if (picked.length >= limit || added >= max) break;
      if (seen.has(r.videoId)) continue;
      seen.add(r.videoId);
      picked.push(r);
      added++;
    }
  };

  const perBucket = Math.max(1, Math.floor(limit / 3));
  const disagreements = list
    .filter((r) => typeof r.aiScore === "number" && Math.abs(r.score - r.aiScore) >= 2)
    .sort((a, b) => Math.abs(b.score - (b.aiScore ?? 0)) - Math.abs(a.score - (a.aiScore ?? 0)) || b.ratedAt - a.ratedAt);
  const favorites = list.filter((r) => r.score >= 8).sort((a, b) => b.score - a.score || b.ratedAt - a.ratedAt);
  const misses = list.filter((r) => r.score <= 4).sort((a, b) => a.score - b.score || b.ratedAt - a.ratedAt);

  take(disagreements, perBucket);
  take(favorites, perBucket);
  take(misses, perBucket);
  take(list, limit - picked.length);

  return picked.map((r) => ({
    title: r.title.slice(0, 140),
    channel: r.channel.slice(0, 80),
    userScore: r.score,
    ...(typeof r.aiScore === "number" ? { aiScore: r.aiScore } : {}),
    ...(r.note ? { note: r.note.slice(0, 140) } : {}),
    ...(r.seconds !== null ? { seconds: r.seconds } : {}),
    ...(r.source ? { source: r.source } : {}),
  }));
}

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function ratingsToCsv(ratings: Record<string, VideoRating>): string {
  const header = [
    "rated_at",
    "video_id",
    "score",
    "ai_score",
    "delta",
    "title",
    "channel",
    "channel_id",
    "source",
    "duration_sec",
    "published",
    "ai_category",
    "ai_brainrot",
    "ai_reason",
    "note",
  ];
  const rows = Object.values(ratings)
    .sort((a, b) => b.ratedAt - a.ratedAt)
    .map((r) => [
      new Date(r.ratedAt).toISOString(),
      r.videoId,
      r.score,
      r.aiScore ?? "",
      typeof r.aiScore === "number" ? r.score - r.aiScore : "",
      r.title,
      r.channel,
      r.channelId,
      r.source ?? "",
      r.seconds ?? "",
      r.published ?? "",
      r.aiCategory ?? "",
      r.aiBrainrot === undefined ? "" : r.aiBrainrot,
      r.aiReason ?? "",
      r.note ?? "",
    ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function ratingsToJson(ratings: Record<string, VideoRating>): string {
  const summary = summarizeRatings(ratings);
  const list = Object.values(ratings).sort((a, b) => b.ratedAt - a.ratedAt);
  return JSON.stringify(
    {
      app: "longform",
      type: "video-ratings",
      exportedAt: new Date().toISOString(),
      summary,
      ratings: list,
    },
    null,
    2,
  );
}
