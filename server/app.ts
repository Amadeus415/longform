import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { audioResponse, warmAudio } from "./audio.ts";
import {
  checkLoginRateLimit,
  clearSessionCookie,
  createMediaToken,
  exchangeNativeAuthCode,
  finishGoogleAuth,
  getSession,
  isAuthEnabled,
  isAuthenticated,
  isGoogleAuthEnabled,
  isPasswordAuthEnabled,
  isPublicSignupEnabled,
  loginRateKey,
  recordFailedLogin,
  requireAuth,
  resetLoginRateLimit,
  securityHeaders,
  setSessionCookie,
  startGoogleAuth,
  verifyPassword,
} from "./auth.ts";
import { enqueueDiscoverJudging } from "./crawler.ts";
import {
  bumpUserTokenVersion,
  getCachedJudgments,
  getUserById,
  getUserState,
  isDbReady,
  patchUserProgress,
  saveUserState,
  setUserYoutubeCookie,
  titleFingerprint,
  upsertUser,
  type SyncedDiscoverEdition,
  type SyncedStatePayload,
} from "./db.ts";
import { canSaveUserYoutubeCookie, getDiscoverCookieStatus, getDiscoverFeed, normalizeYoutubeCookie } from "./discover.ts";
import { geminiModel, getJudgeStatus, judgeVideos, type JudgeCandidate } from "./judge.ts";
import { findNewsSources, getNewsAvatarImage, getNewsSourceFeed, parseSourceId } from "./news.ts";
import { checkRateLimit } from "./ratelimit.ts";
import { findChannels, getAvatarImage, getChannelFeed, isChannelId, isVideoId } from "./youtube.ts";
import { CANONICAL_RUBRIC_VERSION, isDefaultPrompt, judgmentKey } from "../src/lib/filter.ts";
import { sanitizeRatingsMap } from "../src/lib/ratings.ts";
import type { ChannelFeed, LlmJudgment, SyncTombstones } from "../src/lib/types.ts";

// The API routes, shared by the always-on Docker/Node server (index.ts) and the Vercel fallback (api/index.ts).
export const app = new Hono();

const DEFAULT_NATIVE_ORIGINS = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function allowedOrigin(origin: string): string | null {
  if (!origin) return null;
  if (DEFAULT_NATIVE_ORIGINS.has(origin)) return origin;
  const extra = (process.env.CORS_ORIGINS ?? "")
    .split(/[,\s]+/)
    .map((o) => o.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return origin;
  const publicUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (publicUrl && origin === publicUrl) return origin;
  return null;
}

app.use(
  "/api/*",
  cors({
    origin: (origin) => allowedOrigin(origin) ?? "",
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Range", "If-Match"],
    exposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
    credentials: true,
    maxAge: 86400,
  }),
);

app.use("*", securityHeaders);

// Streaming request body size caps BEFORE any route reads or buffers the body (prevents unauthenticated OOM DoS!).
const bodyTooLarge = (c: Context) => c.json({ error: "Request payload is too large." }, 413);
const authBodyLimit = bodyLimit({ maxSize: 16 * 1024, onError: bodyTooLarge });
const syncBodyLimit = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: bodyTooLarge });
const defaultApiBodyLimit = bodyLimit({ maxSize: 256 * 1024, onError: bodyTooLarge });

app.use("/api/*", (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return authBodyLimit(c, next);
  if (c.req.path === "/api/me/state") return syncBodyLimit(c, next);
  return defaultApiBodyLimit(c, next);
});

app.use("/api/*", requireAuth);

function activeUserId(c: Context): string {
  return getSession(c)?.uid ?? "local";
}

function isOwnerCaller(c: Context): boolean {
  if (!isAuthEnabled()) return true;
  const session = getSession(c);
  if (!session) return false;
  const stored = getUserById(session.uid);
  return (stored?.role ?? session.role) === "owner";
}

function rateIdentity(c: Context): string {
  const session = getSession(c);
  return session ? `u:${session.uid}` : `ip:${loginRateKey(c)}`;
}

function enforceRateLimit(c: Context, scope: string, limit: number, windowMs: number): Response | null {
  const res = checkRateLimit(`${scope}:${rateIdentity(c)}`, limit, windowMs);
  if (!res.ok) {
    c.header("Retry-After", String(res.retryAfterSec));
    c.header("Cache-Control", "no-store");
    return c.json({ error: "Rate limit exceeded. Please wait a moment and try again." }, 429);
  }
  return null;
}

async function readJsonWithCap<T>(c: Context, maxBytes: number): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, res: c.json({ error: "Request payload is too large." }, 413) };
  }
  if (!text.trim()) return { ok: true, data: {} as T };
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, res: c.json({ error: "Invalid JSON payload." }, 400) };
  }
}

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    auth: isAuthEnabled(),
    sync: isDbReady(),
    judgeAvailable: getJudgeStatus().available,
  }),
);

app.get("/api/auth/status", (c) => {
  c.header("Cache-Control", "no-store");
  const session = getSession(c);
  const authed = isAuthenticated(c);
  const storedUser = session ? getUserById(session.uid) : null;
  const user = session
    ? {
        id: session.uid,
        email: storedUser?.email ?? session.email,
        name: storedUser?.name ?? session.name,
        avatarUrl: storedUser?.avatarUrl ?? undefined,
        role: storedUser?.role ?? session.role ?? "user",
      }
    : undefined;
  return c.json({
    protected: isAuthEnabled(),
    authenticated: authed,
    email: user?.email,
    user,
    syncEnabled: isDbReady() && Boolean(session),
    publicSignup: isPublicSignupEnabled(),
    mediaToken: session ? createMediaToken(session) : undefined,
    methods: {
      google: isGoogleAuthEnabled(),
      password: isPasswordAuthEnabled(),
    },
  });
});

app.get("/api/auth/google", (c) => startGoogleAuth(c));
app.get("/api/auth/google/callback", (c) => finishGoogleAuth(c));
app.post("/api/auth/native/exchange", (c) => exchangeNativeAuthCode(c));

app.post("/api/auth/login", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!isPasswordAuthEnabled()) return c.json({ error: "Passcode sign-in is not enabled." }, 403);
  const key = loginRateKey(c);
  const limit = checkLoginRateLimit(key);
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfterSec));
    return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!verifyPassword(password)) {
    recordFailedLogin(key);
    return c.json({ error: "Incorrect passcode." }, 401);
  }
  resetLoginRateLimit(key);
  const owner = upsertUser({ id: "owner", name: "Owner", role: "owner" });
  const tv = owner?.tokenVersion ?? 1;
  const token = setSessionCookie(c, undefined, { uid: "owner", role: "owner", tv });
  if (body?.native === true) {
    return c.json({
      ok: true,
      token,
      mediaToken: createMediaToken({ uid: "owner", tv }),
      user: { id: "owner", name: "Owner", role: "owner" },
    });
  }
  return c.json({ ok: true });
});

app.post("/api/auth/logout", (c) => {
  c.header("Cache-Control", "no-store");
  const session = getSession(c);
  if (session) bumpUserTokenVersion(session.uid);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------- Per-user synced library, rules & lightweight progress ----------

const MAX_SYNC_BYTES = 2 * 1024 * 1024;
const MAX_PROGRESS_ENTRIES = 1_500;
const MAX_TOMBSTONES_PER_GROUP = 1_000;

function sanitizeTimestampMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries: [string, number][] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && k.trim() && typeof v === "number" && Number.isFinite(v) && v > 0) {
      entries.push([k.trim().slice(0, 128), Math.round(v)]);
    }
  }
  if (entries.length > MAX_TOMBSTONES_PER_GROUP) {
    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, MAX_TOMBSTONES_PER_GROUP));
  }
  return Object.fromEntries(entries);
}

function sanitizeTombstones(raw: unknown): SyncTombstones {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    channels: sanitizeTimestampMap(obj.channels),
    blockedChannels: sanitizeTimestampMap(obj.blockedChannels),
    ratings: sanitizeTimestampMap(obj.ratings),
    newsSources: sanitizeTimestampMap(obj.newsSources),
  };
}

function sanitizeProgressVideo(raw: unknown, fallbackId: string): Record<string, unknown> {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    id: typeof obj.id === "string" && isVideoId(obj.id) ? obj.id : fallbackId,
    title: typeof obj.title === "string" ? obj.title.slice(0, 220) : "",
    channel: typeof obj.channel === "string" ? obj.channel.slice(0, 120) : "",
    channelId: typeof obj.channelId === "string" && isChannelId(obj.channelId) ? obj.channelId : "",
    seconds: typeof obj.seconds === "number" && Number.isFinite(obj.seconds) && obj.seconds >= 0 ? Math.round(obj.seconds) : null,
    published: typeof obj.published === "string" ? obj.published.slice(0, 64) : "",
  };
}

function pruneProgressMap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, { at?: number; t?: number; d?: number; done?: boolean; video?: unknown }>);
  if (entries.length > MAX_PROGRESS_ENTRIES) {
    entries.sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0));
    entries.length = MAX_PROGRESS_ENTRIES;
  }
  const out: Record<string, unknown> = {};
  for (const [id, p] of entries) {
    if (!p || typeof p !== "object") continue;
    out[id] = {
      t: typeof p.t === "number" && Number.isFinite(p.t) ? Math.max(0, p.t) : 0,
      d: typeof p.d === "number" && Number.isFinite(p.d) ? Math.max(0, p.d) : 0,
      at: typeof p.at === "number" && Number.isFinite(p.at) ? Math.round(p.at) : 0,
      done: Boolean(p.done),
      video: sanitizeProgressVideo(p.video, id),
    };
  }
  return out;
}

const MAX_CHANNELS_PER_USER = 500;
const MAX_NEWS_SOURCES_PER_USER = 200;

function sanitizeChannelList(raw: unknown): Array<{ id: string; title: string; addedAt?: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; title: string; addedAt?: number }> = [];
  const seen = new Set<string>();
  for (const ch of raw) {
    if (out.length >= MAX_CHANNELS_PER_USER) break;
    if (!ch || typeof ch !== "object") continue;
    const obj = ch as { id?: unknown; title?: unknown; addedAt?: unknown };
    if (typeof obj.id !== "string" || !isChannelId(obj.id) || typeof obj.title !== "string") continue;
    if (seen.has(obj.id)) continue;
    seen.add(obj.id);
    const addedAt = typeof obj.addedAt === "number" && Number.isFinite(obj.addedAt) && obj.addedAt > 0 ? Math.round(obj.addedAt) : undefined;
    out.push({ id: obj.id, title: obj.title.slice(0, 120), ...(addedAt ? { addedAt } : {}) });
  }
  return out;
}

function sanitizeDiscoverEdition(raw: unknown): SyncedDiscoverEdition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as { editionDay?: unknown; lockedIds?: unknown };
  if (typeof obj.editionDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(obj.editionDay)) return null;
  if (!Array.isArray(obj.lockedIds)) return null;
  const lockedIds = [...new Set(obj.lockedIds.filter((id): id is string => typeof id === "string" && isVideoId(id)))].slice(0, 30);
  if (!lockedIds.length) return null;
  return { editionDay: obj.editionDay, lockedIds };
}

function sanitizeListenedByDevice(raw: unknown): Record<string, Record<string, number>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, number>> = {};
  for (const [devId, map] of Object.entries(raw as Record<string, unknown>).slice(0, 20)) {
    if (!devId || devId.length > 64 || !map || typeof map !== "object" || Array.isArray(map)) continue;
    const cleanDays: Record<string, number> = {};
    for (const [day, sec] of Object.entries(map as Record<string, unknown>).slice(0, 400)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof sec === "number" && Number.isFinite(sec) && sec >= 0 && sec <= 86400) {
        cleanDays[day] = sec;
      }
    }
    if (Object.keys(cleanDays).length) out[devId] = cleanDays;
  }
  return out;
}

function sanitizeSyncPayload(raw: unknown): SyncedStatePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const channels = sanitizeChannelList(obj.channels);
  const blockedChannels = sanitizeChannelList(obj.blockedChannels);
  const newsSources = Array.isArray(obj.newsSources)
    ? obj.newsSources
        .filter(
          (src) =>
            Boolean(src) &&
            typeof src === "object" &&
            typeof (src as { id?: unknown }).id === "string" &&
            Boolean(parseSourceId((src as { id: string }).id)) &&
            typeof (src as { title?: unknown }).title === "string",
        )
        .slice(0, MAX_NEWS_SOURCES_PER_USER)
    : [];
  const history = Array.isArray(obj.history) ? obj.history.slice(-100) : [];
  const newsHistory = Array.isArray(obj.newsHistory) ? obj.newsHistory.slice(-100) : [];
  const progress = pruneProgressMap(obj.progress);
  const ratings = sanitizeRatingsMap(obj.ratings);
  const settings = obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings) ? (obj.settings as Record<string, unknown>) : {};
  const listened = obj.listened && typeof obj.listened === "object" && !Array.isArray(obj.listened) ? (obj.listened as Record<string, number>) : {};
  const listenedByDevice = sanitizeListenedByDevice(obj.listenedByDevice);
  const newsRead = obj.newsRead && typeof obj.newsRead === "object" && !Array.isArray(obj.newsRead) ? (obj.newsRead as Record<string, number>) : {};
  const tombstones = sanitizeTombstones(obj.tombstones);
  const discoverEdition = sanitizeDiscoverEdition(obj.discoverEdition);
  return { channels, blockedChannels, history, progress, ratings, settings, listened, listenedByDevice, newsSources, newsHistory, newsRead, tombstones, discoverEdition };
}

app.get("/api/me/state", (c) => {
  c.header("Cache-Control", "no-store");
  if (!isDbReady()) return c.json({ error: "Cloud sync is not configured on this server." }, 503);
  const session = getSession(c);
  if (!session) return c.json({ error: "Sign in to sync your library." }, 401);
  upsertUser({ id: session.uid, email: session.email, name: session.name, role: session.role });
  const stored = getUserState(session.uid);
  if (!stored) return c.json({ state: null, updatedAt: 0, revision: 0 });
  return c.json(stored);
});

app.put("/api/me/state", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!isDbReady()) return c.json({ error: "Cloud sync is not configured on this server." }, 503);
  const session = getSession(c);
  if (!session) return c.json({ error: "Sign in to sync your library." }, 401);
  const limited = enforceRateLimit(c, "sync-state", 60, 15 * 60_000);
  if (limited) return limited;

  const parsedBody = await readJsonWithCap<{ state?: unknown; expectedRevision?: unknown }>(c, MAX_SYNC_BYTES);
  if (!parsedBody.ok) return parsedBody.res;

  const payload = sanitizeSyncPayload(parsedBody.data?.state ?? parsedBody.data);
  if (!payload) return c.json({ error: "Invalid state payload." }, 400);

  const ifMatch = c.req.header("if-match");
  const rawExpected =
    typeof parsedBody.data?.expectedRevision === "number"
      ? parsedBody.data.expectedRevision
      : ifMatch
        ? Number(ifMatch.replace(/^"|"$/g, ""))
        : undefined;
  const expectedRevision = typeof rawExpected === "number" && Number.isFinite(rawExpected) ? rawExpected : undefined;

  upsertUser({ id: session.uid, email: session.email, name: session.name, role: session.role });
  const saved = saveUserState(session.uid, payload, expectedRevision);
  if (!saved.ok) {
    if (saved.conflict) {
      return c.json({ error: "State revision conflict", conflict: true, current: saved.current }, 409);
    }
    return c.json({ error: "Could not save state." }, 500);
  }
  return c.json({ ok: true, updatedAt: saved.updatedAt, revision: saved.revision });
});

app.patch("/api/me/progress", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!isDbReady()) return c.json({ error: "Cloud sync is not configured on this server." }, 503);
  const session = getSession(c);
  if (!session) return c.json({ error: "Sign in to sync your library." }, 401);
  const limited = enforceRateLimit(c, "sync-progress", 120, 15 * 60_000);
  if (limited) return limited;

  const parsedBody = await readJsonWithCap<{
    progress?: Record<string, unknown>;
    listened?: Record<string, unknown>;
    deviceId?: unknown;
    deviceListened?: Record<string, unknown>;
  }>(c, 32 * 1024);
  if (!parsedBody.ok) return parsedBody.res;

  const cleanProgress: Record<string, { t: number; d: number; at: number; done?: boolean; video: Record<string, unknown> }> = {};
  if (parsedBody.data.progress && typeof parsedBody.data.progress === "object") {
    for (const [id, raw] of Object.entries(parsedBody.data.progress).slice(0, 20)) {
      if (!isVideoId(id) || !raw || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      const t = typeof p.t === "number" && Number.isFinite(p.t) ? Math.max(0, p.t) : 0;
      const d = typeof p.d === "number" && Number.isFinite(p.d) ? Math.max(0, p.d) : 0;
      const at = typeof p.at === "number" && Number.isFinite(p.at) ? Math.round(p.at) : Date.now();
      if (d > 0) cleanProgress[id] = { t, d, at, done: Boolean(p.done), video: sanitizeProgressVideo(p.video, id) };
    }
  }

  const cleanDayMap = (raw: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [day, sec] of Object.entries(raw as Record<string, unknown>).slice(0, 14)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof sec === "number" && Number.isFinite(sec) && sec >= 0 && sec <= 86400) {
        out[day] = sec;
      }
    }
    return out;
  };

  const deviceId =
    typeof parsedBody.data.deviceId === "string" && /^[a-zA-Z0-9_-]{4,48}$/.test(parsedBody.data.deviceId)
      ? parsedBody.data.deviceId
      : undefined;

  upsertUser({ id: session.uid, email: session.email, name: session.name, role: session.role });
  const saved = patchUserProgress(session.uid, {
    progress: cleanProgress,
    listened: cleanDayMap(parsedBody.data.listened),
    deviceId,
    deviceListened: deviceId ? cleanDayMap(parsedBody.data.deviceListened) : undefined,
  });
  if (!saved) return c.json({ error: "Could not save progress." }, 500);
  return c.json({ ok: true, ...saved });
});

// ---------- Channel feeds (single + batched, with zero-cost passive cached judgment attachment) ----------

app.get("/api/channel/:id", async (c) => {
  const limited = enforceRateLimit(c, "channel", 120, 15 * 60_000);
  if (limited) return limited;
  const id = c.req.param("id");
  if (!isChannelId(id)) return c.json({ error: "Not a channel ID" }, 400);
  try {
    const feed = await getChannelFeed(id, { userId: activeUserId(c) });
    c.header(
      "Cache-Control",
      isAuthEnabled() ? "private, max-age=300" : "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
    );
    return c.json(feed);
  } catch (error) {
    console.error(`[channel] ${id}: ${(error as Error).message}`);
    return c.json({ error: "Could not load this channel" }, 502);
  }
});

/** Batched channel refresh so clients fetch up to 50 channels + any already-cached AI judgments in one round-trip. */
app.post("/api/channels/batch", async (c) => {
  c.header("Cache-Control", "no-store");
  const limited = enforceRateLimit(c, "channels-batch", 15, 15 * 60_000);
  if (limited) return limited;

  const parsed = await readJsonWithCap<{ ids?: unknown[] }>(c, 32 * 1024);
  if (!parsed.ok) return parsed.res;

  const ids = Array.isArray(parsed.data.ids)
    ? [...new Set(parsed.data.ids.filter((id): id is string => typeof id === "string" && isChannelId(id)))].slice(0, 50)
    : [];

  const feeds: Record<string, ChannelFeed> = {};
  const failed: string[] = [];
  const uid = activeUserId(c);

  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        feeds[id] = await getChannelFeed(id, { userId: uid });
      } catch {
        failed.push(id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, ids.length || 1) }, worker));

  // Passively attach any already-cached canonical judgments ($0 LLM cost) so ratings on followed videos pair with AI scores.
  // Pass expected title hashes so A/B title-changed videos never receive stale verdicts.
  const allVideos = Object.values(feeds).flatMap((f) => f.videos);
  const expectedTitleHashes: Record<string, string> = {};
  for (const v of allVideos) {
    if (v.title) expectedTitleHashes[v.id] = titleFingerprint(v.title);
  }
  const model = geminiModel();
  const rawCached = getCachedJudgments(
    allVideos.map((v) => `${v.id}:${CANONICAL_RUBRIC_VERSION}:${model}`),
    expectedTitleHashes,
  );
  const cachedJudgments: Record<string, LlmJudgment> = {};
  for (const j of Object.values(rawCached)) {
    cachedJudgments[judgmentKey(j.videoId, j.rubricHash)] = j;
  }

  return c.json({ feeds, failed, cachedJudgments });
});

app.get("/api/avatar/:id", async (c) => {
  const limited = enforceRateLimit(c, "avatar", 240, 15 * 60_000);
  if (limited) return limited;
  const id = c.req.param("id");
  if (!isChannelId(id)) return c.body(null, 400);
  const image = await getAvatarImage(id).catch(() => null);
  if (!image) return c.body(null, 404);
  return c.body(image.bytes, 200, {
    "Content-Type": image.type,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": isAuthEnabled() ? "private, max-age=86400" : "public, max-age=86400",
  });
});

app.get("/api/channels/find", async (c) => {
  const limited = enforceRateLimit(c, "channels-find", 30, 15 * 60_000);
  if (limited) return limited;
  try {
    return c.json(await findChannels(c.req.query("q") ?? "", activeUserId(c)));
  } catch (error) {
    console.error(`[find] ${(error as Error).message}`);
    return c.json({ error: "Search failed" }, 502);
  }
});

// ---------- Recommendations (Discover) & Server-Owned Poison-Proof Gemini AI Judge ----------

app.get("/api/discover/status", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    ...getDiscoverCookieStatus(activeUserId(c), isOwnerCaller(c)),
    judge: getJudgeStatus(),
  });
});

app.post("/api/discover", async (c) => {
  c.header("Cache-Control", "no-store");
  const limited = enforceRateLimit(c, "discover", 10, 15 * 60_000);
  if (limited) return limited;

  const parsed = await readJsonWithCap<{
    seeds?: { id?: unknown; channel?: unknown; title?: unknown }[];
    excludeChannelIds?: unknown[];
    excludeChannelNames?: unknown[];
    force?: unknown;
  }>(c, 64 * 1024);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const seeds = Array.isArray(body?.seeds)
    ? body.seeds
        .filter((s) => s && typeof s === "object" && typeof s.id === "string")
        .map((s) => ({
          id: String(s.id),
          channel: typeof s.channel === "string" ? s.channel.slice(0, 80) : undefined,
          title: typeof s.title === "string" ? s.title.slice(0, 160) : undefined,
        }))
    : [];
  const excludeChannelIds = Array.isArray(body?.excludeChannelIds)
    ? body.excludeChannelIds.filter((id): id is string => typeof id === "string")
    : [];
  const excludeChannelNames = Array.isArray(body?.excludeChannelNames)
    ? body.excludeChannelNames.filter((n): n is string => typeof n === "string").slice(0, 500)
    : [];

  try {
    const owner = isOwnerCaller(c);
    const feed = await getDiscoverFeed({
      userId: activeUserId(c),
      seeds,
      excludeChannelIds,
      excludeChannelNames,
      allowBypassCache: body?.force === true && owner,
      allowEnvCookie: owner,
    });
    if (feed.videos.length) enqueueDiscoverJudging(feed.videos.slice(0, 15));
    return c.json(feed);
  } catch (error) {
    console.error(`[discover] ${(error as Error).message}`);
    return c.json({ error: "Could not load recommendations" }, 502);
  }
});

app.post("/api/discover/cookie", async (c) => {
  c.header("Cache-Control", "no-store");
  const limited = enforceRateLimit(c, "discover-cookie", 10, 15 * 60_000);
  if (limited) return limited;
  if (!canSaveUserYoutubeCookie()) {
    return c.json(
      { error: "Per-user YouTube cookies are disabled on public multi-user servers for account security." },
      403,
    );
  }
  const parsed = await readJsonWithCap<{ cookie?: unknown }>(c, 64 * 1024);
  if (!parsed.ok) return parsed.res;
  const raw = typeof parsed.data?.cookie === "string" ? parsed.data.cookie : "";
  const normalized = normalizeYoutubeCookie(raw);
  if (!normalized) return c.json({ error: "Paste a valid YouTube Cookie header or Netscape cookies.txt." }, 400);
  setUserYoutubeCookie(activeUserId(c), normalized);
  return c.json({ ok: true, ...getDiscoverCookieStatus(activeUserId(c), isOwnerCaller(c)) });
});

app.delete("/api/discover/cookie", (c) => {
  c.header("Cache-Control", "no-store");
  setUserYoutubeCookie(activeUserId(c), null);
  return c.json({ ok: true, ...getDiscoverCookieStatus(activeUserId(c), isOwnerCaller(c)) });
});

app.get("/api/judge/status", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(getJudgeStatus());
});

app.post("/api/judge", async (c) => {
  c.header("Cache-Control", "no-store");
  const parsed = await readJsonWithCap<{
    videos?: unknown[];
    rubric?: unknown;
    force?: unknown;
  }>(c, 128 * 1024);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const rubric = typeof body?.rubric === "string" ? body.rubric : undefined;
  const isCustomRubric = Boolean(rubric && !isDefaultPrompt(rubric));

  const limited = enforceRateLimit(c, isCustomRubric ? "judge-custom" : "judge", isCustomRubric ? 6 : 20, 15 * 60_000);
  if (limited) return limited;

  const videos: JudgeCandidate[] = Array.isArray(body?.videos)
    ? body.videos
        .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string"))
        .map((v) => ({
          id: String(v.id),
          source: v.source === "discover" ? "discover" : "following",
        }))
    : [];

  const result = await judgeVideos({
    videos,
    rubric,
    userId: activeUserId(c),
    force: body?.force === true,
    allowForce: isOwnerCaller(c),
    priority: "interactive",
  });
  return c.json(result);
});

app.on(["GET", "HEAD"], "/api/audio/:id", (c) => {
  const limited = enforceRateLimit(c, "audio", 120, 15 * 60_000);
  if (limited) return limited;
  return audioResponse(c.req.raw, c.req.param("id"));
});
app.post("/api/audio/:id/warm", (c) => {
  const limited = enforceRateLimit(c, "audio-warm", 15, 15 * 60_000);
  if (limited) return limited;
  warmAudio(c.req.param("id"));
  return c.body(null, 204);
});

// Zero-cost news & social sources (Bluesky public API, RSS/Atom, Hacker News).
app.get("/api/news/source", async (c) => {
  const limited = enforceRateLimit(c, "news-source", 120, 15 * 60_000);
  if (limited) return limited;
  const id = c.req.query("id") ?? "";
  if (!parseSourceId(id)) return c.json({ error: "Invalid news source ID" }, 400);
  try {
    const feed = await getNewsSourceFeed(id);
    c.header(
      "Cache-Control",
      isAuthEnabled() ? "private, max-age=300" : "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
    );
    return c.json(feed);
  } catch (error) {
    console.error(`[news] ${id}: ${(error as Error).message}`);
    return c.json({ error: "Could not load this source" }, 502);
  }
});

app.get("/api/news/find", async (c) => {
  const limited = enforceRateLimit(c, "news-find", 30, 15 * 60_000);
  if (limited) return limited;
  try {
    return c.json(await findNewsSources(c.req.query("q") ?? ""));
  } catch (error) {
    console.error(`[news-find] ${(error as Error).message}`);
    return c.json({ error: "Search failed" }, 502);
  }
});

app.get("/api/news/avatar", async (c) => {
  const limited = enforceRateLimit(c, "news-avatar", 240, 15 * 60_000);
  if (limited) return limited;
  const id = c.req.query("id") ?? "";
  if (!parseSourceId(id)) return c.body(null, 400);
  const image = await getNewsAvatarImage(id).catch(() => null);
  if (!image) return c.body(null, 404);
  return c.body(image.bytes, 200, {
    "Content-Type": image.type,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": isAuthEnabled() ? "private, max-age=86400" : "public, max-age=86400",
  });
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
