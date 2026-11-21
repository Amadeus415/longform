import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { audioResponse, warmAudio } from "./audio.ts";
import { STARTER_PACKS } from "../src/lib/starter.ts";
import { findChannels, getAvatarImage, getChannelFeed, isChannelId, warmAvatars } from "./youtube.ts";

const app = new Hono();

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

if (process.env.NODE_ENV === "production") {
  app.use("/assets/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  });
  app.use("*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Longform server on http://localhost:${port}`);
  warmAvatars(STARTER_PACKS.flatMap((p) => p.channels.map((c) => c.id)));
});
