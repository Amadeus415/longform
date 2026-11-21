import { describe, expect, it } from "vitest";
import { applyRules, clock, contains, DEFAULT_RULES, describeChanges, judge, normalizeRules, type Rules } from "../src/lib/filter";
import type { Video } from "../src/lib/types";

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
  it("hides short videos and says why", () => {
    expect(judge(video({ seconds: 494 }), rules, ctx)).toEqual({
      show: false,
      rule: "minMinutes",
      reason: "Shorter than 20 min (8:14)",
    });
  });
  it("treats unknown length as short only when a minimum is set", () => {
    expect(judge(video({ seconds: null }), rules, ctx)).toMatchObject({ show: false, rule: "minMinutes" });
    expect(judge(video({ seconds: null }), { ...rules, minMinutes: 0 }, ctx)).toEqual({ show: true });
  });
  it("applies the longest and oldest limits only when set", () => {
    const long = video({ seconds: 4 * 3600 });
    expect(judge(long, rules, ctx).show).toBe(true);
    expect(judge(long, { ...rules, maxMinutes: 180 }, ctx)).toMatchObject({ rule: "maxMinutes", reason: "Longer than 180 min (4:00:00)" });
    const old = video({ published: "2026-01-01T00:00:00Z" });
    expect(judge(old, rules, ctx).show).toBe(true);
    expect(judge(old, { ...rules, maxAgeDays: 30 }, ctx)).toMatchObject({ rule: "maxAgeDays" });
  });
  it("hides titles with hidden words unless an allowed word is present", () => {
    const clip = video({ title: "Best clips from the lecture" });
    expect(judge(clip, rules, ctx)).toMatchObject({ rule: "hideWords", reason: "Title contains “clips”" });
    expect(judge(clip, { ...rules, allowWords: ["lecture"] }, ctx)).toEqual({ show: true });
  });
  it("hides finished videos when asked", () => {
    const finished = { now: NOW, finished: new Set(["abcdefghijk"]) };
    expect(judge(video(), rules, finished)).toMatchObject({ rule: "hideFinished" });
    expect(judge(video(), { ...rules, hideFinished: false }, finished)).toEqual({ show: true });
  });
});

describe("applyRules", () => {
  it("sorts newest first, dedupes, and splits shown from hidden", () => {
    const videos = [
      video({ id: "old00000000", published: "2026-11-01T00:00:00Z" }),
      video({ id: "new00000000", published: "2026-11-20T00:00:00Z" }),
      video({ id: "short000000", seconds: 60 }),
      video({ id: "new00000000", published: "2026-11-20T00:00:00Z" }),
    ];
    const { shown, hidden } = applyRules(videos, rules, ctx);
    expect(shown.map((v) => v.id)).toEqual(["new00000000", "old00000000"]);
    expect(hidden.map((h) => h.video.id)).toEqual(["short000000"]);
  });
  it("is deterministic", () => {
    const videos = Array.from({ length: 50 }, (_, i) =>
      video({ id: `v${String(i).padStart(10, "0")}`, seconds: i * 60, published: new Date(NOW - i * 3_600_000).toISOString() }),
    );
    expect(applyRules(videos, rules, ctx)).toEqual(applyRules([...videos].reverse(), rules, ctx));
  });
});

describe("describeChanges", () => {
  it("lists each change in plain words", () => {
    const after: Rules = { ...rules, minMinutes: 30, maxAgeDays: 14, hideWords: [...rules.hideWords.filter((w) => w !== "clip"), "drama"], hideFinished: false };
    expect(describeChanges(rules, after)).toEqual([
      "Shortest: 20 min → 30 min",
      "Oldest: off → 14 days",
      "Hide + “drama”",
      "Hide − “clip”",
      "Hide finished: on → off",
    ]);
    expect(describeChanges(rules, { ...rules })).toEqual([]);
  });
});

describe("normalizeRules", () => {
  it("fills gaps and drops junk", () => {
    expect(normalizeRules(null)).toEqual(DEFAULT_RULES);
    expect(normalizeRules({ minMinutes: -5, maxMinutes: "x", hideWords: ["a", " a ", 3, ""], hideFinished: "yes" })).toEqual({
      ...DEFAULT_RULES,
      hideWords: ["a"],
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
