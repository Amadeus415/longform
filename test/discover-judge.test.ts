import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../server/app";
import { clearAllCaches } from "../server/cache";
import { resetDbForTests, upsertCatalogVideos } from "../server/db";
import { normalizeYoutubeCookie, parseRelativePublished, parseYoutubeNode } from "../server/discover";
import { clearJudgeMemoryCacheForTests, judgeVideos } from "../server/judge";
import { resetRateLimitsForTests } from "../server/ratelimit";
import { blendFeed } from "../src/lib/useFeed";
import type { Video } from "../src/lib/types";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_DAILY_BUDGET",
  "YOUTUBE_COOKIE",
  "YTDLP_COOKIES_B64",
  "DATABASE_PATH",
  "ALLOW_PUBLIC_SIGNUP",
  "ALLOW_USER_YOUTUBE_COOKIES",
  "SESSION_SECRET",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  resetDbForTests(":memory:");
  clearAllCaches();
  clearJudgeMemoryCacheForTests();
  resetRateLimitsForTests();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("discover helpers", () => {
  it("normalizes both raw Cookie headers and Netscape cookies.txt files", () => {
    expect(normalizeYoutubeCookie("Cookie: SID=abc123; HSID=def456")).toBe("SID=abc123; HSID=def456");

    const netscape = [
      "# Netscape HTTP Cookie File",
      ".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tnetscape_sid",
      ".example.com\tTRUE\t/\tTRUE\t1800000000\tOTHER\tignored",
      ".google.com\tTRUE\t/\tTRUE\t1800000000\tHSID\tnetscape_hsid",
    ].join("\n");
    expect(normalizeYoutubeCookie(netscape)).toBe("SID=netscape_sid; HSID=netscape_hsid");
    expect(normalizeYoutubeCookie("not a cookie")).toBeNull();
  });

  it("parses relative publish timestamps cleanly and returns empty string instead of fabricating dates", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(parseRelativePublished("2 hours ago", now)).toBe("2026-11-27T10:00:00.000Z");
    expect(parseRelativePublished("Streamed 3 days ago", now)).toBe("2026-11-24T12:00:00.000Z");
    expect(parseRelativePublished(undefined, now)).toBe("");
    expect(parseRelativePublished("unknown date", now)).toBe("");
  });

  it("drops Shorts and live streams while preserving channels like Live Science", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(parseYoutubeNode({ type: "ShortsLockupView", content_id: "aaaaaaaaaaa" }, now)).toBeNull();
    expect(
      parseYoutubeNode(
        {
          type: "CompactVideo",
          video_id: "short123456",
          title: { text: "Tiny short" },
          duration: { seconds: 45 },
          author: { name: "Creator", id: "UC1111111111111111111111" },
        },
        now,
      ),
    ).toBeNull();

    const parsed = parseYoutubeNode(
      {
        type: "LockupView",
        content_type: "VIDEO",
        content_id: "educ1234567",
        duration: { seconds: 740, text: "12:20" },
        metadata: {
          title: { text: "How Transformers Actually Work" },
          image: { renderer_context: { command_context: { on_tap: { payload: { browseId: "UCYO_jab_esuFRV4b17AJtAw" } } } } },
          metadata: {
            metadata_rows: [
              { metadata_parts: [{ text: { text: "Live Science" } }] },
              { metadata_parts: [{ text: { text: "1.2M views" } }, { text: { text: "4 days ago" } }] },
            ],
          },
        },
      },
      now,
    );
    expect(parsed).toMatchObject({
      id: "educ1234567",
      title: "How Transformers Actually Work",
      channel: "Live Science",
      channelId: "UCYO_jab_esuFRV4b17AJtAw",
      seconds: 740,
      source: "discover",
    });

    // Actual live stream (metadata part after channel says "watching") IS dropped.
    const liveStream = parseYoutubeNode(
      {
        type: "LockupView",
        content_type: "VIDEO",
        content_id: "live1234567",
        metadata: {
          title: { text: "24/7 News Stream" },
          metadata: {
            metadata_rows: [
              { metadata_parts: [{ text: { text: "News Desk" } }] },
              { metadata_parts: [{ text: { text: "12K watching" } }] },
            ],
          },
        },
      },
      now,
    );
    expect(liveStream).toBeNull();
  });

  it("enforces a hard <= 20% discover cap in blended feed even on small follow lists", () => {
    const mk = (id: string, source: "following" | "discover"): Video => ({
      id,
      title: id,
      channelId: "UC1111111111111111111111",
      channel: "Ch",
      published: "2026-11-27T00:00:00Z",
      seconds: 900,
      source,
    });
    // 8 followed + 6 discover -> max 2 discover (20%)
    const eightF = Array.from({ length: 8 }, (_, i) => mk(`f${i + 1}`, "following"));
    const sixD = Array.from({ length: 6 }, (_, i) => mk(`d${i + 1}`, "discover"));
    expect(blendFeed(eightF, sixD).map((v) => v.id)).toEqual(["f1", "f2", "d1", "f3", "f4", "f5", "f6", "d2", "f7", "f8"]);

    // Small follow list (3 followed + 6 discover) -> max 1 discover (never 67% discover!)
    const threeF = [mk("f1", "following"), mk("f2", "following"), mk("f3", "following")];
    expect(blendFeed(threeF, sixD).map((v) => v.id)).toEqual(["f1", "f2", "d1", "f3"]);
  });
});

describe("Gemini LLM judge & discover cookie routes", () => {
  it("reports unavailable gracefully when GEMINI_API_KEY is unset", async () => {
    const res = await app.request("/api/discover/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      hasCookie: false,
      source: "none",
      judge: { available: false, provider: "gemini", model: "gemini-3.5-flash-lite" },
    });
  });

  it("scores server-catalog videos once via Gemini and serves subsequent requests from shared SQLite cache", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    // Populate trusted server-side video catalog first (as YouTube ingestion does).
    upsertCatalogVideos([
      {
        id: "vid00000001",
        title: "Quantum Tunneling in 10 Minutes",
        channel: "Physics Lab",
        channelId: "UC1111111111111111111111",
        published: "2026-11-25T00:00:00Z",
        seconds: 600,
        source: "discover",
      },
      {
        id: "vid00000002",
        title: "Influencer EXPOSED in Wild Drama",
        channel: "Tea Daily",
        channelId: "UC2222222222222222222222",
        published: "2026-11-25T00:00:00Z",
        seconds: 1500,
        source: "discover",
      },
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      { id: "vid00000001", score: 9, depth: 9, clickbait: 1, ragebait: 1, brainrot: false, format: "explainer", category: "Science", reason: "Clear 10m physics explainer" },
                      { id: "vid00000002", score: 2, depth: 1, clickbait: 10, ragebait: 9, brainrot: true, format: "slop", category: "Drama", reason: "Celebrity gossip ragebait" },
                    ]),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const candidates = [{ id: "vid00000001" }, { id: "vid00000002" }];

    const first = await judgeVideos({ videos: candidates, userId: "alice" });
    expect(first.available).toBe(true);
    expect(first.scoredCount).toBe(2);
    expect(first.cachedCount).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call (even from a different user!) hits shared SQLite cache without calling Gemini again.
    const second = await judgeVideos({ videos: candidates, userId: "bob" });
    expect(second.scoredCount).toBe(0);
    expect(second.cachedCount).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Object.values(second.judgments).find((j) => j.videoId === "vid00000001")).toMatchObject({
      score: 9,
      depth: 9,
      clickbait: 1,
      ragebait: 1,
      brainrot: false,
      format: "explainer",
      category: "Science",
    });
    expect(Object.values(second.judgments).find((j) => j.videoId === "vid00000002")).toMatchObject({
      score: 2,
      brainrot: true,
    });
  });

  it("saves and clears YouTube cookies encrypted at rest without ever echoing them back", async () => {
    process.env.SESSION_SECRET = "test-secret-for-aes-gcm";
    const saveRes = await app.request("/api/discover/cookie", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "SID=secret123; HSID=secret456" }),
    });
    expect(saveRes.status).toBe(200);
    const saveBody = await saveRes.json();
    expect(saveBody).toEqual({ ok: true, hasCookie: true, source: "user", canSaveCookie: true });
    expect(JSON.stringify(saveBody)).not.toContain("secret123");

    const delRes = await app.request("/api/discover/cookie", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true, hasCookie: false, source: "none", canSaveCookie: true });
  });
});
