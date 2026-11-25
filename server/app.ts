import { Hono } from "hono";
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
import { getUserById, getUserState, isDbReady, saveUserState, upsertUser, type SyncedStatePayload } from "./db.ts";
import { findNewsSources, getNewsAvatarImage, getNewsSourceFeed, parseSourceId } from "./news.ts";
import { findChannels, getAvatarImage, getChannelFeed, isChannelId } from "./youtube.ts";

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
    allowMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Range"],
    exposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
    credentials: true,
    maxAge: 86400,
  }),
);

app.use("*", securityHeaders);
app.use("/api/*", requireAuth);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    auth: isAuthEnabled(),
    sync: isDbReady(),
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
  upsertUser({ id: "owner", name: "Owner", role: "owner" });
  const token = setSessionCookie(c, undefined, { uid: "owner", role: "owner" });
  if (body?.native === true) {
    return c.json({
      ok: true,
      token,
      mediaToken: createMediaToken({ uid: "owner" }),
      user: { id: "owner", name: "Owner", role: "owner" },
    });
  }
  return c.json({ ok: true });
});

app.post("/api/auth/logout", (c) => {
  c.header("Cache-Control", "no-store");
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------- Per-user synced library & rules ----------

const MAX_SYNC_BYTES = 2 * 1024 * 1024; // 2 MB cap per user state snapshot

function sanitizeSyncPayload(raw: unknown): SyncedStatePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const channels = Array.isArray(obj.channels)
    ? obj.channels.filter(
        (ch): ch is { id: string; title: string } =>
          Boolean(ch) &&
          typeof ch === "object" &&
          typeof (ch as { id?: unknown }).id === "string" &&
          isChannelId((ch as { id: string }).id) &&
          typeof (ch as { title?: unknown }).title === "string",
      )
    : [];
  const newsSources = Array.isArray(obj.newsSources)
    ? obj.newsSources.filter(
        (src) =>
          Boolean(src) &&
          typeof src === "object" &&
          typeof (src as { id?: unknown }).id === "string" &&
          Boolean(parseSourceId((src as { id: string }).id)) &&
          typeof (src as { title?: unknown }).title === "string",
      )
    : [];
  const history = Array.isArray(obj.history) ? obj.history.slice(-100) : [];
  const newsHistory = Array.isArray(obj.newsHistory) ? obj.newsHistory.slice(-100) : [];
  const progress = obj.progress && typeof obj.progress === "object" && !Array.isArray(obj.progress) ? (obj.progress as Record<string, unknown>) : {};
  const settings = obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings) ? (obj.settings as Record<string, unknown>) : {};
  const listened = obj.listened && typeof obj.listened === "object" && !Array.isArray(obj.listened) ? (obj.listened as Record<string, number>) : {};
  const newsRead = obj.newsRead && typeof obj.newsRead === "object" && !Array.isArray(obj.newsRead) ? (obj.newsRead as Record<string, number>) : {};
  return { channels, history, progress, settings, listened, newsSources, newsHistory, newsRead };
}

app.get("/api/me/state", (c) => {
  c.header("Cache-Control", "no-store");
  if (!isDbReady()) return c.json({ error: "Cloud sync is not configured on this server." }, 503);
  const session = getSession(c);
  if (!session) return c.json({ error: "Sign in to sync your library." }, 401);
  // Ensure user exists even if signed in via a pre-existing valid cookie/token after DB init.
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
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_SYNC_BYTES) {
    return c.json({ error: "State payload is too large." }, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400);
  }
  const payload = sanitizeSyncPayload((parsed as { state?: unknown })?.state ?? parsed);
  if (!payload) return c.json({ error: "Invalid state payload." }, 400);
  upsertUser({ id: session.uid, email: session.email, name: session.name, role: session.role });
  const saved = saveUserState(session.uid, payload);
  if (!saved) return c.json({ error: "Could not save state." }, 500);
  return c.json({ ok: true, ...saved });
});

// One channel's latest long-form uploads. Responses are the same for everyone, so a CDN can cache them when public.
app.get("/api/channel/:id", async (c) => {
  const id = c.req.param("id");
  if (!isChannelId(id)) return c.json({ error: "Not a channel ID" }, 400);
  try {
    const feed = await getChannelFeed(id);
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

// A channel's avatar, so the app can use <img src="/api/avatar/UC…"> anywhere.
app.get("/api/avatar/:id", async (c) => {
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
  try {
    return c.json(await findChannels(c.req.query("q") ?? ""));
  } catch (error) {
    console.error(`[find] ${(error as Error).message}`);
    return c.json({ error: "Search failed" }, 502);
  }
});

app.on(["GET", "HEAD"], "/api/audio/:id", (c) => audioResponse(c.req.raw, c.req.param("id")));
app.post("/api/audio/:id/warm", (c) => {
  warmAudio(c.req.param("id"));
  return c.body(null, 204);
});

// Zero-cost news & social sources (Bluesky public API, RSS/Atom, Hacker News).
app.get("/api/news/source", async (c) => {
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
  try {
    return c.json(await findNewsSources(c.req.query("q") ?? ""));
  } catch (error) {
    console.error(`[news-find] ${(error as Error).message}`);
    return c.json({ error: "Search failed" }, 502);
  }
});

app.get("/api/news/avatar", async (c) => {
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
