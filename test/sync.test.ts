import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../server/app";
import { createSessionToken } from "../server/auth";
import { resetDbForTests } from "../server/db";
import { DEFAULT_RULES } from "../src/lib/filter";
import { DEFAULT_NEWS_RULES } from "../src/lib/newsFilter";
import type { SyncedState } from "../src/lib/store";
import { mergeSyncedState } from "../src/lib/sync";

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOW_PUBLIC_SIGNUP", "SESSION_SECRET", "DATABASE_PATH"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  resetDbForTests(":memory:");
  process.env.GOOGLE_CLIENT_ID = "client-123";
  process.env.GOOGLE_CLIENT_SECRET = "secret-xyz";
  process.env.ALLOW_PUBLIC_SIGNUP = "true";
  process.env.SESSION_SECRET = "sync-test-secret";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("multi-user state sync API", () => {
  it("isolates synced state per user across web and mobile", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const aliceToken = createSessionToken(nowSec, "alice@example.com", { uid: "google:alice" });
    const bobToken = createSessionToken(nowSec, "bob@example.com", { uid: "google:bob" });

    // Alice starts empty on server.
    const emptyRes = await app.request("/api/me/state", { headers: { Authorization: `Bearer ${aliceToken}` } });
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json()).toEqual({ state: null, updatedAt: 0, revision: 0 });

    // Alice saves her channels & news sources.
    const putAlice = await app.request("/api/me/state", {
      method: "PUT",
      headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        state: {
          channels: [{ id: "UCXZCJLdBC09xxGZ6gcdrc6A", title: "OpenAI" }, { id: "not-valid", title: "Bad" }],
          newsSources: [{ id: "hn:front_page", kind: "hn", title: "Hacker News" }],
          history: [],
          progress: {},
          settings: { theme: "dark" },
          listened: { "2026-11-25": 1200 },
          newsHistory: [],
          newsRead: { "hn:1": 1000 },
        },
      }),
    });
    expect(putAlice.status).toBe(200);
    expect(await putAlice.json()).toMatchObject({ ok: true, revision: 1 });

    // Alice reads back her sanitized state (invalid channel ID dropped).
    const getAlice = await app.request("/api/me/state", { headers: { Authorization: `Bearer ${aliceToken}` } });
    const aliceData = (await getAlice.json()) as { state: SyncedState; revision: number };
    expect(aliceData.revision).toBe(1);
    expect(aliceData.state.channels).toEqual([{ id: "UCXZCJLdBC09xxGZ6gcdrc6A", title: "OpenAI" }]);
    expect(aliceData.state.newsSources).toEqual([{ id: "hn:front_page", kind: "hn", title: "Hacker News" }]);
    expect(aliceData.state.listened).toEqual({ "2026-11-25": 1200 });

    // Bob is completely isolated from Alice's data.
    const getBob = await app.request("/api/me/state", { headers: { Authorization: `Bearer ${bobToken}` } });
    expect(await getBob.json()).toEqual({ state: null, updatedAt: 0, revision: 0 });
  });
});

describe("mergeSyncedState", () => {
  it("unions channels/sources, keeps latest playback progress, and preserves non-default rules", () => {
    const baseSettings = { mode: "listen" as const, frames: true, theme: "auto" as const, rate: 1, continueOnLock: true };
    const local: SyncedState = {
      channels: [{ id: "UC1111111111111111111111", title: "Local Channel" }],
      history: [{ v: 1, at: 100, rules: DEFAULT_RULES, changes: ["Default rules"] }],
      progress: {
        vid1: {
          t: 900,
          d: 1800,
          at: 5000,
          video: { id: "vid1", title: "Ep 1", channel: "A", channelId: "UC1111111111111111111111", seconds: 1800, published: "2026-11-20" },
        },
      },
      settings: baseSettings,
      listened: { "2026-11-25": 900 },
      newsSources: [{ id: "hn:front_page", kind: "hn", title: "Hacker News" }],
      newsHistory: [{ v: 1, at: 100, rules: DEFAULT_NEWS_RULES, changes: ["Default news rules"] }],
      newsRead: { a: 1000 },
    };

    const remote: SyncedState = {
      channels: [{ id: "UC2222222222222222222222", title: "Remote Channel" }],
      history: [
        { v: 1, at: 100, rules: DEFAULT_RULES, changes: ["Default rules"] },
        { v: 2, at: 2000, rules: { ...DEFAULT_RULES, minMinutes: 30 }, changes: ["Minimum length → 30 min"] },
      ],
      progress: {
        vid1: {
          t: 300,
          d: 1800,
          at: 2000,
          video: { id: "vid1", title: "Ep 1", channel: "A", channelId: "UC1111111111111111111111", seconds: 1800, published: "2026-11-20" },
        },
      },
      settings: { ...baseSettings, theme: "dark" },
      listened: { "2026-11-25": 600, "2026-11-24": 1800 },
      newsSources: [{ id: "bsky:reuters.com", kind: "bsky", title: "Reuters" }],
      newsHistory: [{ v: 1, at: 100, rules: DEFAULT_NEWS_RULES, changes: ["Default news rules"] }],
      newsRead: { b: 2000 },
    };

    const { merged, needsPush } = mergeSyncedState(local, remote);
    expect(merged.channels.map((c) => c.id)).toEqual(["UC2222222222222222222222", "UC1111111111111111111111"]);
    expect(merged.newsSources.map((s) => s.id)).toEqual(["bsky:reuters.com", "hn:front_page"]);
    expect(merged.progress.vid1.t).toBe(900); // local had newer timestamp
    expect(merged.listened).toEqual({ "2026-11-25": 900, "2026-11-24": 1800 });
    expect(merged.history).toHaveLength(2); // remote had real edits
    expect(merged.newsRead).toEqual({ b: 2000, a: 1000 });
    expect(merged.settings.theme).toBe("dark");
    expect(needsPush).toBe(true);
  });
});
