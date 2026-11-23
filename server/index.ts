import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { STARTER_PACKS } from "../src/lib/starter.ts";
import { app } from "./app.ts";
import { warmAvatars } from "./youtube.ts";

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
