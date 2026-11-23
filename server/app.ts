import { Hono } from "hono";
import { audioResponse, warmAudio } from "./audio.ts";
import { findNewsSources, getNewsAvatarImage, getNewsSourceFeed, parseSourceId } from "./news.ts";
import { findChannels, getAvatarImage, getChannelFeed, isChannelId } from "./youtube.ts";

// The API routes, shared by the long-running server (index.ts) and the Vercel function (api/index.ts).
export const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

// One channel's latest long-form uploads. Responses are the same for everyone, so a CDN can cache them.
app.get("/api/channel/:id", async (c) => {
  const id = c.req.param("id");
  if (!isChannelId(id)) return c.json({ error: "Not a channel ID" }, 400);
  try {
    const feed = await getChannelFeed(id);
    c.header("Cache-Control", "public, max-age=300, s-maxage=900, stale-while-revalidate=86400");
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
  return c.body(image.bytes, 200, { "Content-Type": image.type, "Cache-Control": "public, max-age=86400" });
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
    c.header("Cache-Control", "public, max-age=300, s-maxage=900, stale-while-revalidate=86400");
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
  return c.body(image.bytes, 200, { "Content-Type": image.type, "Cache-Control": "public, max-age=86400" });
});
