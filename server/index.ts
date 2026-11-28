import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { STARTER_PACKS } from "../src/lib/starter.ts";
import { app } from "./app.ts";
import { startBackgroundCrawler } from "./crawler.ts";
import { getJudgeStatus } from "./judge.ts";
import { warmAvatars } from "./youtube.ts";

// Load local .env automatically when present (ignored if missing; never overrides existing env vars).
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile?.(file);
  } catch {}
}

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
  const judge = getJudgeStatus();
  console.log(`Longform server on http://localhost:${port}`);
  console.log(
    judge.available
      ? `[judge] Gemini active (model=${judge.model}, dailyBudget=${judge.dailyBudget} videos/day)`
      : `[judge] Gemini inactive (set GEMINI_API_KEY to enable AI educational scoring; model=${judge.model})`,
  );
  startBackgroundCrawler();
  warmAvatars(STARTER_PACKS.flatMap((p) => p.channels.map((c) => c.id)));
});
