import { Hono } from "hono";
import { audioResponse, warmAudio } from "./audio.ts";
import {
  checkLoginRateLimit,
  clearSessionCookie,
  finishGoogleAuth,
  getSession,
  isAuthEnabled,
  isAuthenticated,
  isGoogleAuthEnabled,
  isPasswordAuthEnabled,
  loginRateKey,
  recordFailedLogin,
  requireAuth,
  resetLoginRateLimit,
  securityHeaders,
  setSessionCookie,
  startGoogleAuth,
  verifyPassword,
} from "./auth.ts";
import { findNewsSources, getNewsAvatarImage, getNewsSourceFeed, parseSourceId } from "./news.ts";
import { findChannels, getAvatarImage, getChannelFeed, isChannelId } from "./youtube.ts";

// The API routes, shared by the long-running server (index.ts) and the Vercel function (api/index.ts).
export const app = new Hono();

app.use("*", securityHeaders);
app.use("/api/*", requireAuth);

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/auth/status", (c) => {
  c.header("Cache-Control", "no-store");
  const session = getSession(c);
  return c.json({
    protected: isAuthEnabled(),
    authenticated: isAuthenticated(c),
    email: session?.email,
    methods: {
      google: isGoogleAuthEnabled(),
      password: isPasswordAuthEnabled(),
    },
  });
});

app.get("/api/auth/google", (c) => startGoogleAuth(c));
app.get("/api/auth/google/callback", (c) => finishGoogleAuth(c));

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
  setSessionCookie(c);
  return c.json({ ok: true });
});

app.post("/api/auth/logout", (c) => {
  c.header("Cache-Control", "no-store");
  clearSessionCookie(c);
  return c.json({ ok: true });
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

app.get("/api/audio/:id", (c) => audioResponse(c.req.raw, c.req.param("id")));
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
