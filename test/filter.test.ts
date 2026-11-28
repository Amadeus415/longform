import { describe, expect, it } from "vitest";
import {
  applyRules,
  clock,
  contains,
  DEFAULT_RULES,
  describeChanges,
  judge,
  judgmentKey,
  normalizeRules,
  rubricHash,
  type Rules,
} from "../src/lib/filter";
import type { LlmJudgment, Video } from "../src/lib/types";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const ctx = { now: NOW, finished: new Set<string>() };
const rules: Rules = { ...DEFAULT_RULES };

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: "abcdefghijk",
    title: "A long conversation about physics",
    channelId: "UCxxxxxxxxxxxxxxxxxxxxxx",
    channel: "Some Podcast",
    published: "2026-11-19T12:00:00Z",
    seconds: 2 * 3600,
    ...overrides,
  };
}

function mkJudgment(videoId: string, overrides: Partial<LlmJudgment> = {}): [string, LlmJudgment] {
  const hash = rubricHash(rules.llm.prompt);
  const j: LlmJudgment = {
    videoId,
    rubricHash: hash,
    score: 8,
    brainrot: false,
    category: "Science",
    reason: "Clear explanation of quantum mechanics",
    model: "gemini-2.5-flash-lite",
    judgedAt: NOW,
    ...overrides,
  };
  return [judgmentKey(videoId, hash), j];
}

describe("contains", () => {
  it("matches whole words, case-insensitively", () => {
    expect(contains("Best CLIPS of the week", "clips")).toBe(true);
    expect(contains("The total eclipse", "clip")).toBe(false);
    expect(contains("clip", "clip")).toBe(true);
  });
  it("matches phrases and punctuation-led words", () => {
    expect(contains("We tried it and it went GONE WRONG", "gone wrong")).toBe(true);
    expect(contains("My day #shorts", "#shorts")).toBe(true);
    expect(contains("Let’s Play Minecraft", "let's play")).toBe(true);
  });
  it("supports a trailing * for word starts", () => {
    expect(contains("Streamer reacting to news", "react*")).toBe(true);
    expect(contains("Overreaction", "react*")).toBe(false);
  });
  it("ignores accents and empty phrases", () => {
    expect(contains("Café culture", "cafe")).toBe(true);
    expect(contains("anything", "  ")).toBe(false);
    expect(contains("anything", "*")).toBe(false);
  });
});

describe("judge", () => {
  it("shows a long, recent video with a clean title", () => {
    expect(judge(video(), rules, ctx)).toEqual({ show: true });
  });
  it("allows concise educational videos under 20 min by default, while hiding micro-clips", () => {
    expect(judge(video({ seconds: 494 }), rules, ctx)).toEqual({ show: true });
    expect(judge(video({ seconds: 90 }), rules, ctx)).toEqual({
      show: false,
      rule: "minMinutes",
      reason: "Shorter than 3 min (1:30)",
    });
    expect(judge(video({ seconds: 494 }), { ...rules, minMinutes: 20 }, ctx)).toEqual({
      show: false,
      rule: "minMinutes",
      reason: "Shorter than 20 min (8:14)",
    });
  });
  it("never falsely hides educational videos with words like reaction, highlights, clip, meme, compilation, reacts to, tiktok, asmr, unboxing, or prank", () => {
    for (const title of [
      "Nuclear chain reaction explained",
      "Highlights of the James Webb first-year results",
      "The paper clip maximizer problem",
      "Meme theory: Dawkins lecture",
      "Game design analysis of Elden Ring gameplay",
      "How your body reacts to extreme cold",
      "How compilation works in Rust",
      "How TikTok's recommendation algorithm works",
      "ASMR and the science of tingles",
      "Unboxing the James Webb mirror design",
      "The prank that fooled Victorian London",
    ]) {
      expect(judge(video({ title }), rules, ctx).show).toBe(true);
    }
  });
  it("treats unknown length as short unless it came from YouTube's UULF long-form feed", () => {
    expect(judge(video({ seconds: null }), rules, ctx)).toMatchObject({ show: false, rule: "minMinutes" });
    expect(judge(video({ seconds: null, fromLongFormFeed: true }), rules, ctx)).toEqual({ show: true });
    expect(judge(video({ seconds: null }), { ...rules, minMinutes: 0 }, ctx)).toEqual({ show: true });
  });
  it("applies the longest and oldest limits cleanly (default 30d window keeps feed finite)", () => {
    const long = video({ seconds: 4 * 3600 });
    expect(judge(long, rules, ctx).show).toBe(true);
    expect(judge(long, { ...rules, maxMinutes: 180 }, ctx)).toMatchObject({ rule: "maxMinutes", reason: "Longer than 180 min (4:00:00)" });
    const old = video({ published: "2026-01-01T00:00:00Z" });
    expect(judge(old, rules, ctx)).toMatchObject({ show: false, rule: "maxAgeDays" });
    expect(judge(old, { ...rules, maxAgeDays: 0 }, ctx).show).toBe(true);
  });
  it("hides titles with hidden phrases unless an allowed word is present", () => {
    const slop = video({ title: "Wild reaction video to viral stunt gone wrong" });
    expect(judge(slop, rules, ctx)).toMatchObject({ rule: "hideWords", reason: "Title contains “reaction video”" });
    expect(judge(slop, { ...rules, allowWords: ["lecture"] }, ctx)).toMatchObject({ rule: "hideWords" });
    expect(judge(video({ title: "Mukbang lecture on food sociology" }), { ...rules, allowWords: ["lecture"] }, ctx)).toEqual({ show: true });
  });
  it("hides finished videos when asked", () => {
    const finished = { now: NOW, finished: new Set(["abcdefghijk"]) };
    expect(judge(video(), rules, finished)).toMatchObject({ rule: "hideFinished" });
    expect(judge(video(), { ...rules, hideFinished: false }, finished)).toEqual({ show: true });
  });
  it("hides blocked channels by ID or fallback channel name", () => {
    const blocked = {
      now: NOW,
      finished: new Set<string>(),
      blockedChannels: new Set(["UCxxxxxxxxxxxxxxxxxxxxxx"]),
      blockedChannelNames: new Set(["slop daily"]),
    };
    expect(judge(video(), rules, blocked)).toMatchObject({ show: false, rule: "blockedChannel" });
    expect(judge(video({ channelId: "", channel: "Slop Daily" }), rules, blocked)).toMatchObject({ show: false, rule: "blockedChannel" });
  });
  it("applies LLM educational score and brainrot flag transparently and respects scope", () => {
    const [kGood, jGood] = mkJudgment("good0000001", { score: 8, brainrot: false, reason: "Clear explainer on neural nets" });
    const [kLow, jLow] = mkJudgment("low00000002", { score: 4, brainrot: false, reason: "Shallow listicle" });
    const [kRot, jRot] = mkJudgment("rot00000003", { score: 7, brainrot: true, reason: "Drama ragebait" });
    const judgments = { [kGood]: jGood, [kLow]: jLow, [kRot]: jRot };

    // Default scope = "discover": leaves followed channel untouched, vets discover videos.
    expect(judge(video({ id: "low00000002", source: "following" }), rules, { ...ctx, judgments })).toEqual({ show: true });
    expect(judge(video({ id: "low00000002", source: "discover" }), rules, { ...ctx, judgments })).toMatchObject({
      show: false,
      rule: "llm",
      reason: "AI (4/10 < 6): Shallow listicle",
    });
    expect(judge(video({ id: "good0000001", seconds: 600, source: "discover" }), rules, { ...ctx, judgments })).toMatchObject({
      show: true,
      judgment: jGood,
    });
    expect(judge(video({ id: "rot00000003", source: "discover" }), rules, { ...ctx, judgments })).toMatchObject({
      show: false,
      rule: "llm",
      reason: "AI (7/10 · brainrot): Drama ragebait",
    });

    // When scope = "all", followed videos are judged too.
    const allScope: Rules = { ...rules, llm: { ...rules.llm, scope: "all" } };
    expect(judge(video({ id: "low00000002", source: "following" }), allScope, { ...ctx, judgments })).toMatchObject({
      show: false,
      rule: "llm",
    });
  });

  it("fails closed for unjudged Discover videos when AI judge is enabled — including when judgeAvailable is null", () => {
    const disc = video({ id: "unjudged001", source: "discover" });
    expect(judge(disc, rules, { ...ctx, judgeAvailable: null })).toMatchObject({ show: false, pending: true, rule: "pending" });
    expect(judge(disc, rules, { ...ctx, judgeAvailable: undefined })).toMatchObject({ show: false, pending: true, rule: "pending" });
    expect(judge(disc, rules, { ...ctx, judgeAvailable: true })).toMatchObject({ show: false, pending: true, rule: "pending" });
    expect(judge(disc, rules, { ...ctx, judgeAvailable: false })).toMatchObject({ show: false, pending: true, rule: "pending" });
  });

  it("exempts Discover from maxAgeDays so evergreen lectures survive", () => {
    const oldLecture = video({
      id: "mitold00001",
      title: "MIT 18.06: Eigenvalues and Eigenvectors",
      published: "2024-01-01T00:00:00Z",
      source: "discover",
    });
    const [k, j] = mkJudgment("mitold00001", { score: 10, brainrot: false });
    expect(judge(oldLecture, rules, { ...ctx, judgments: { [k]: j }, judgeAvailable: true }).show).toBe(true);
  });
});

describe("applyRules", () => {
  it("sorts newest first, dedupes, caps per-channel floods, and splits shown from hidden", () => {
    const videos = [
      video({ id: "old00000000", published: "2026-11-10T00:00:00Z" }),
      video({ id: "new00000000", published: "2026-11-20T00:00:00Z" }),
      video({ id: "mid00000000", published: "2026-11-15T00:00:00Z" }),
      video({ id: "short000000", seconds: 60 }),
      video({ id: "new00000000", published: "2026-11-20T00:00:00Z" }),
    ];
    // Default maxPerChannel = 2 trims the 3rd video from the same channel with rule "channelCap".
    const { shown, hidden, channelOverflow } = applyRules(videos, rules, ctx);
    expect(shown.map((v) => v.id)).toEqual(["new00000000", "mid00000000"]);
    expect(hidden.map((h) => [h.video.id, h.rule])).toEqual([
      ["short000000", "minMinutes"],
      ["old00000000", "channelCap"],
    ]);
    expect(channelOverflow["UCxxxxxxxxxxxxxxxxxxxxxx"]).toBe(1);
  });
  it("is deterministic", () => {
    const videos = Array.from({ length: 50 }, (_, i) =>
      video({
        id: `v${String(i).padStart(10, "0")}`,
        channelId: `UC${String(i % 10).padStart(22, "0")}`,
        seconds: i * 60,
        published: new Date(NOW - i * 3_600_000).toISOString(),
      }),
    );
    expect(applyRules(videos, rules, ctx)).toEqual(applyRules([...videos].reverse(), rules, ctx));
  });
});

describe("describeChanges", () => {
  it("lists each change in plain words", () => {
    const after: Rules = {
      ...rules,
      minMinutes: 30,
      maxAgeDays: 14,
      maxPerChannel: 3,
      dailyBudgetMinutes: 60,
      hideWords: [...rules.hideWords.filter((w) => w !== "mukbang"), "drama"],
      hideFinished: false,
      llm: { ...rules.llm, minScore: 8, scope: "all" },
    };
    expect(describeChanges(rules, after)).toEqual([
      "Shortest: 3 min → 30 min",
      "Oldest: 30 days → 14 days",
      "Channel cap: 2/channel → 3/channel",
      "Hide + “drama”",
      "Hide − “mukbang”",
      "Hide finished: on → off",
      "Daily budget: off → 60 min",
      "AI min score: 6/10 → 8/10",
      "AI scope: discover → all",
    ]);
    expect(describeChanges(rules, { ...rules })).toEqual([]);
  });
});

describe("normalizeRules", () => {
  it("fills gaps and drops junk", () => {
    expect(normalizeRules(null)).toEqual(DEFAULT_RULES);
    expect(
      normalizeRules({
        minMinutes: -5,
        maxMinutes: "x",
        hideWords: ["a", " a ", 3, ""],
        hideFinished: "yes",
        llm: { minScore: 99, scope: "weird" },
      }),
    ).toEqual({
      ...DEFAULT_RULES,
      hideWords: ["a"],
      llm: { ...DEFAULT_RULES.llm, minScore: 10 },
    });
  });
});

describe("clock", () => {
  it("formats durations", () => {
    expect(clock(494)).toBe("8:14");
    expect(clock(12074)).toBe("3:21:14");
    expect(clock(3600)).toBe("1:00:00");
  });
});
