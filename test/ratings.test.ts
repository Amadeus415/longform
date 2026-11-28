import { describe, expect, it } from "vitest";
import { buildJudgePrompt } from "../server/judge";
import { buildTasteProfile, computePersonalScore } from "../src/lib/personalize";
import {
  buildCalibrationExamples,
  normalizeRatingScore,
  ratingsToCsv,
  ratingsToJson,
  sanitizeRatingsMap,
  summarizeRatings,
} from "../src/lib/ratings";
import type { LlmJudgment, VideoRating } from "../src/lib/types";

function mkRating(overrides: Partial<VideoRating> & { videoId: string; score: number }): VideoRating {
  return {
    ratedAt: 1700000000000,
    title: `Video ${overrides.videoId}`,
    channel: "Science Channel",
    channelId: "UC1111111111111111111111",
    seconds: 1800,
    source: "following",
    ...overrides,
  };
}

describe("ratings normalization & analytics", () => {
  it("validates 1-10 integer scores and drops invalid entries", () => {
    expect(normalizeRatingScore(1)).toBe(1);
    expect(normalizeRatingScore(10)).toBe(10);
    expect(normalizeRatingScore(7.6)).toBe(8);
    expect(normalizeRatingScore(0)).toBeNull();
    expect(normalizeRatingScore(11)).toBeNull();
    expect(normalizeRatingScore("abc")).toBeNull();

    const clean = sanitizeRatingsMap({
      v1: { videoId: "v1", score: 9, ratedAt: 1000, title: "Good", channel: "Ch", channelId: "UC1", seconds: 900 },
      v2: { videoId: "v2", score: 0, ratedAt: 1000, title: "Bad", channel: "Ch", channelId: "UC1", seconds: 900 },
      v3: null,
    });
    expect(Object.keys(clean)).toEqual(["v1"]);
    expect(clean.v1.score).toBe(9);
  });

  it("summarizes distribution, channel averages, length buckets, and AI alignment", () => {
    const ratings: Record<string, VideoRating> = {
      a: mkRating({
        videoId: "a",
        score: 10,
        aiScore: 9,
        aiCategory: "Science",
        channel: "3Blue1Brown",
        channelId: "UC1",
        seconds: 900,
        source: "following",
        ratedAt: 1000,
      }),
      b: mkRating({
        videoId: "b",
        score: 8,
        aiScore: 8,
        aiCategory: "Science",
        channel: "3Blue1Brown",
        channelId: "UC1",
        seconds: 4000,
        source: "following",
        ratedAt: 2000,
      }),
      c: mkRating({
        videoId: "c",
        score: 3,
        aiScore: 8,
        aiCategory: "Business",
        channel: "Hype Cast",
        channelId: "UC2",
        seconds: 2400,
        source: "discover",
        ratedAt: 3000,
        note: "Too much fluff",
      }),
    };

    const s = summarizeRatings(ratings);
    expect(s.count).toBe(3);
    expect(s.avgScore).toBe(7);
    expect(s.highCount).toBe(2);
    expect(s.lowCount).toBe(1);
    expect(s.distribution[2]).toBe(1);
    expect(s.distribution[7]).toBe(1);
    expect(s.distribution[9]).toBe(1);
    expect(s.bySource.following).toEqual({ count: 2, avgScore: 9 });
    expect(s.bySource.discover).toEqual({ count: 1, avgScore: 3 });
    expect(s.byChannel[0]).toMatchObject({ label: "3Blue1Brown", avgScore: 9, count: 2 });
    expect(s.byChannel[1]).toMatchObject({ label: "Hype Cast", avgScore: 3, count: 1 });
    expect(s.byLength.map((l) => l.key)).toEqual(["concise", "short", "mid"]);
    expect(s.aiAlignment.pairedCount).toBe(3);
    expect(s.aiAlignment.meanAbsError).toBe(2);
    expect(s.aiAlignment.bias).toBe(1.3);
    expect(s.aiAlignment.disagreements).toHaveLength(1);
    expect(s.aiAlignment.disagreements[0]).toMatchObject({ delta: -5 });
  });

  it("keeps canonical judge prompt user-independent while applying ratings deterministically on-device", () => {
    const ratings: Record<string, VideoRating> = {
      fav1: mkRating({ videoId: "fav1", score: 10, aiScore: 8, aiCategory: "Science", channel: "3B1B", channelId: "UC3B1B", title: "Linear Algebra", ratedAt: 3000 }),
      fav2: mkRating({ videoId: "fav2", score: 9, aiScore: 8, aiCategory: "Science", channel: "3B1B", channelId: "UC3B1B", title: "Calculus", ratedAt: 3500 }),
      miss1: mkRating({ videoId: "miss1", score: 2, aiScore: 7, aiCategory: "Drama", channel: "Slop", channelId: "UCSLOP", title: "AI Hype Clickbait", note: "Pure hype", ratedAt: 4000 }),
      miss2: mkRating({ videoId: "miss2", score: 2, aiScore: 7, aiCategory: "Drama", channel: "Slop", channelId: "UCSLOP", title: "More Drama", ratedAt: 4500 }),
    };

    const examples = buildCalibrationExamples(ratings, 6);
    expect(examples.map((e) => e.title)).toContain("AI Hype Clickbait");
    expect(examples.map((e) => e.title)).toContain("Linear Algebra");

    // Canonical server prompt wraps video metadata as untrusted data and uses fixed anchors (no cross-user leak).
    const prompt = buildJudgePrompt(
      [{ id: "cand0000001", title: "New Video", channel: "Creator", seconds: 1200 }],
      "Keep educational videos",
    );
    expect(prompt).toContain("<UNTRUSTED_VIDEO_DATA>");
    expect(prompt).toContain("Calibration anchors");

    // On-device personalization boosts favorite channel/category and penalizes low-rated channel/category immediately.
    const profile = buildTasteProfile(ratings);
    const baseJudgment: LlmJudgment = {
      videoId: "cand0000001",
      rubricHash: "canonical:v2",
      score: 7,
      brainrot: false,
      category: "Science",
      reason: "Good explainer",
      model: "gemini-2.5-flash-lite",
      judgedAt: Date.now(),
    };
    const favScore = computePersonalScore(
      { id: "cand0000001", title: "Eigenvectors", channel: "3B1B", channelId: "UC3B1B" },
      baseJudgment,
      profile,
    );
    const slopScore = computePersonalScore(
      { id: "cand0000002", title: "Hot take", channel: "Slop", channelId: "UCSLOP" },
      { ...baseJudgment, videoId: "cand0000002", category: "Drama" },
      profile,
    );
    expect(favScore.effectiveScore).toBeGreaterThan(slopScore.effectiveScore);
    expect(favScore.breakdown.length).toBeGreaterThan(0);
  });

  it("exports valid CSV and JSON with summary", () => {
    const ratings: Record<string, VideoRating> = {
      v1: mkRating({
        videoId: "v1",
        score: 9,
        aiScore: 7,
        title: 'How "CPUs", Really Work',
        channel: "Hardware Lab",
        note: "Loved the diagrams",
      }),
    };
    const csv = ratingsToCsv(ratings);
    expect(csv).toContain("rated_at,video_id,score,ai_score,delta");
    expect(csv).toContain('v1,9,7,2,"How ""CPUs"", Really Work",Hardware Lab');
    expect(csv).toContain("Loved the diagrams");

    const parsed = JSON.parse(ratingsToJson(ratings));
    expect(parsed.type).toBe("video-ratings");
    expect(parsed.summary.count).toBe(1);
    expect(parsed.ratings[0].score).toBe(9);
  });
});
