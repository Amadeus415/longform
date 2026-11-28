/**
 * Live Gemini evaluation harness for the 276-video real YouTube benchmark
 * (`test/fixtures/real-youtube-benchmark.json`).
 *
 * Usage:
 *   npx tsx scripts/eval-judge.ts [--save] [--blind] [--limit N]
 *
 * - Runs on the exact shipped `DEFAULT_MODEL` unless `GEMINI_MODEL` is overridden.
 * - Computes accuracy, precision, recall, F1, and Wilson 95% confidence intervals
 *   overall, by difficulty (`clear` vs `borderline`), and by archetype.
 * - With `--save`, writes raw per-video judgments + summary to `docs/eval-results.json`.
 * - With `--blind`, strips descriptions and replaces channel names with `"Channel"`
 *   to measure title-only robustness without channel/description cues.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MODEL, judgeVideos } from "../server/judge.ts";
import { DEFAULT_RULES, judgeDeterministic } from "../src/lib/filter.ts";
import type { LlmJudgment, Video } from "../src/lib/types.ts";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile?.(file);
  } catch {}
}
// Use isolated in-memory SQLite and generous eval quota so evaluation never touches production DB.
process.env.DATABASE_PATH = ":memory:";
process.env.GEMINI_USER_DAILY_BUDGET = "2000";
// Default to the exact shipped DEFAULT_MODEL unless explicitly overridden by CLI `--model`.
const modelArgIdx = process.argv.indexOf("--model");
if (modelArgIdx !== -1 && process.argv[modelArgIdx + 1]) {
  process.env.GEMINI_MODEL = process.argv[modelArgIdx + 1];
} else {
  process.env.GEMINI_MODEL = DEFAULT_MODEL;
}

type BenchmarkRow = {
  id: string;
  title: string;
  channel: string;
  channelId: string;
  seconds: number;
  description?: string;
  label: "educational" | "brainrot" | "short_slop";
  archetype: string;
  difficulty: "clear" | "borderline";
};

type EvalRecord = {
  id: string;
  title: string;
  channel: string;
  seconds: number;
  label: BenchmarkRow["label"];
  archetype: string;
  difficulty: BenchmarkRow["difficulty"];
  stage: "deterministic" | "llm";
  kept: boolean;
  correct: boolean;
  deterministicReason?: string;
  judgment?: Pick<LlmJudgment, "score" | "depth" | "clickbait" | "ragebait" | "brainrot" | "format" | "category" | "reason">;
};

function wilson95(successes: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];
  const z = 1.959963984540054;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denom;
  return [Number(Math.max(0, center - half).toFixed(4)), Number(Math.min(1, center + half).toFixed(4))];
}

function summarize(records: EvalRecord[]) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (const r of records) {
    const expectedKeep = r.label === "educational";
    if (expectedKeep && r.kept) tp++;
    else if (expectedKeep && !r.kept) fn++;
    else if (!expectedKeep && r.kept) fp++;
    else tn++;
  }
  const n = records.length;
  const correct = tp + tn;
  const accuracy = n ? correct / n : 0;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    n,
    tp,
    tn,
    fp,
    fn,
    accuracy: Number(accuracy.toFixed(4)),
    accuracyWilson95: wilson95(correct, n),
    precision: Number(precision.toFixed(4)),
    precisionWilson95: wilson95(tp, tp + fp),
    recall: Number(recall.toFixed(4)),
    recallWilson95: wilson95(tp, tp + fn),
    f1: Number(f1.toFixed(4)),
  };
}

const saveResults = process.argv.includes("--save");
const blindMode = process.argv.includes("--blind");
const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx !== -1 ? Number(process.argv[limitIdx + 1]) || 0 : 0;
const delayIdx = process.argv.indexOf("--delay-ms");
const delayMs = delayIdx !== -1 ? Number(process.argv[delayIdx + 1]) || 0 : 2_000;
const stratIdx = process.argv.indexOf("--per-archetype");
const perArchetype = stratIdx !== -1 ? Number(process.argv[stratIdx + 1]) || 0 : 0;

const benchmarkPath = resolve(process.cwd(), "test/fixtures/real-youtube-benchmark.json");
const allRows = JSON.parse(readFileSync(benchmarkPath, "utf8")) as BenchmarkRow[];
let sample: BenchmarkRow[];
if (perArchetype > 0) {
  const byArch = new Map<string, BenchmarkRow[]>();
  for (const r of allRows) {
    const list = byArch.get(r.archetype) ?? [];
    list.push(r);
    byArch.set(r.archetype, list);
  }
  sample = [];
  for (const list of byArch.values()) sample.push(...list.slice(0, perArchetype));
} else {
  sample = limit > 0 ? allRows.slice(0, limit) : allRows;
}

const now = Date.now();
const detCtx = { now, finished: new Set<string>() };
const records: EvalRecord[] = [];
const survivors: BenchmarkRow[] = [];

for (const row of sample) {
  const v: Video = {
    id: row.id,
    title: row.title,
    channel: blindMode ? "Channel" : row.channel,
    channelId: row.channelId,
    published: new Date(now - 2 * 86_400_000).toISOString(),
    seconds: row.seconds,
    description: blindMode ? undefined : row.description,
    source: "discover",
  };
  const det = judgeDeterministic(v, DEFAULT_RULES, detCtx);
  if (!det.show) {
    const expectedKeep = row.label === "educational";
    records.push({
      id: row.id,
      title: row.title,
      channel: row.channel,
      seconds: row.seconds,
      label: row.label,
      archetype: row.archetype,
      difficulty: row.difficulty,
      stage: "deterministic",
      kept: false,
      correct: !expectedKeep,
      deterministicReason: det.reason,
    });
  } else {
    survivors.push(row);
  }
}

console.log(
  `Benchmark: ${sample.length} real YouTube videos (mode=${blindMode ? "blind-title-only" : "full-metadata"}, model=${process.env.GEMINI_MODEL}).`,
);
console.log(
  `Stage 1 deterministic filtered ${sample.length - survivors.length}/${sample.length}. Sending ${survivors.length} survivors to Gemini...`,
);

const allJudgments: Record<string, LlmJudgment> = {};
let usedModel = "";
for (let i = 0; i < survivors.length; i += 30) {
  const chunk = survivors.slice(i, i + 30);
  const res = await judgeVideos({
    videos: chunk.map((r) => ({
      id: r.id,
      title: r.title,
      channel: blindMode ? "Channel" : r.channel,
      seconds: r.seconds,
      description: blindMode ? undefined : r.description,
      source: "discover",
    })),
    trustedMetadata: true,
    skipEnrichment: true,
    userId: "eval-harness",
    force: true,
    allowForce: true,
  });
  if (!res.available) {
    console.error("Set GEMINI_API_KEY to run the live LLM evaluation.");
    process.exit(1);
  }
  usedModel = res.model;
  if (res.error) console.error("Batch warning:", res.error);
  for (const j of Object.values(res.judgments)) {
    allJudgments[j.videoId] = j;
  }
  if (delayMs > 0 && i + 30 < survivors.length) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

for (const row of survivors) {
  const j = allJudgments[row.id];
  const kept = Boolean(j && !j.brainrot && j.score >= DEFAULT_RULES.llm.minScore);
  const expectedKeep = row.label === "educational";
  records.push({
    id: row.id,
    title: row.title,
    channel: row.channel,
    seconds: row.seconds,
    label: row.label,
    archetype: row.archetype,
    difficulty: row.difficulty,
    stage: "llm",
    kept,
    correct: kept === expectedKeep,
    judgment: j
      ? {
          score: j.score,
          depth: j.depth,
          clickbait: j.clickbait,
          ragebait: j.ragebait,
          brainrot: j.brainrot,
          format: j.format,
          category: j.category,
          reason: j.reason,
        }
      : undefined,
  });
}

const overall = summarize(records);
const byDifficulty = {
  clear: summarize(records.filter((r) => r.difficulty === "clear")),
  borderline: summarize(records.filter((r) => r.difficulty === "borderline")),
};
const archetypes = [...new Set(records.map((r) => r.archetype))];
const byArchetype: Record<string, ReturnType<typeof summarize>> = {};
for (const a of archetypes) {
  byArchetype[a] = summarize(records.filter((r) => r.archetype === a));
}

const misclassified = records
  .filter((r) => !r.correct)
  .map((r) => ({
    id: r.id,
    title: r.title,
    channel: r.channel,
    label: r.label,
    archetype: r.archetype,
    difficulty: r.difficulty,
    stage: r.stage,
    kept: r.kept,
    detail: r.judgment
      ? `${r.judgment.score}/10 brainrot=${r.judgment.brainrot} (${r.judgment.reason})`
      : r.deterministicReason || "missing judgment",
  }));

const report = {
  evaluatedAt: new Date().toISOString(),
  benchmarkFile: "test/fixtures/real-youtube-benchmark.json",
  mode: blindMode ? "blind-title-only" : "full-metadata",
  model: usedModel || process.env.GEMINI_MODEL,
  shippedDefaultModel: DEFAULT_MODEL,
  rules: {
    minMinutes: DEFAULT_RULES.minMinutes,
    llmMinScore: DEFAULT_RULES.llm.minScore,
    hideBrainrot: DEFAULT_RULES.llm.hideBrainrot,
  },
  overall,
  byDifficulty,
  byArchetype,
  misclassified,
  results: records,
};

if (saveResults && !blindMode) {
  const outPath = resolve(process.cwd(), "docs/eval-results.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved full raw per-video results to ${outPath}`);
}

console.log(
  JSON.stringify(
    {
      model: report.model,
      shippedDefaultModel: report.shippedDefaultModel,
      mode: report.mode,
      overall: report.overall,
      byDifficulty: report.byDifficulty,
      byArchetype: report.byArchetype,
      misclassifiedCount: misclassified.length,
      misclassified,
    },
    null,
    2,
  ),
);
