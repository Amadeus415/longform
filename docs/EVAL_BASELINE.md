# Video Algorithm Evaluation Baseline

Measured on **2026-11-27** using [`scripts/eval-judge.ts`](../scripts/eval-judge.ts) on the **exact shipped default model (`gemini-3.5-flash-lite`)** against **276 real YouTube videos** harvested from YouTube Search and Watch-Next in [`test/fixtures/real-youtube-benchmark.json`](../test/fixtures/real-youtube-benchmark.json).

Every raw per-video judgment (video ID, title, channel, duration, label, difficulty, stage, Gemini score, depth, clickbait, ragebait, brainrot, format, category, reason) is committed in [`docs/eval-results.json`](./eval-results.json) for full auditability.

## Real YouTube Dataset Composition (276 Videos, 13 Archetypes)

- **100% real YouTube videos** (authentic 11-character YouTube IDs, real channel names, real titles, real durations, and real descriptions from YouTube; no synthetic placeholder IDs or giveaway channel names).
- **210 clear + 66 genuine borderline/gray-zone videos** (sensational-titled science/economics/history videos, real Watch-Next Discover candidates with no descriptions, a 50-minute cultural essay about celebrity gossip, day-in-the-life SWE vlogs, minimalist desk tours, gadget unboxings, and Top-15 listicles).
- **Leakage guard:** The 6 calibration anchors inside [`server/judge.ts`](../server/judge.ts) are completely distinct from every video in `real-youtube-benchmark.json`, and `titleHeuristicFlags` are NOT injected into the Gemini prompt.

| Archetype | n | Label | Difficulty | Full-Metadata Acc. | Blind Title-Only Acc. (stratified) |
| --- | ---: | --- | --- | ---: | ---: |
| `core_educational` | 85 | `educational` | clear | 98.82% (84/85) | 100.0% (10/10) |
| `sensational_title_educational` | 36 | `educational` | borderline | 100.0% (36/36) | 100.0% (10/10) |
| `watch_next_discover` | 22 | `educational` | clear & borderline (no descriptions) | 100.0% (22/22) | 100.0% (10/10) |
| `borderline_podcast_or_review` | 1 | `educational` | borderline | 100.0% (1/1) | 100.0% (1/1) |
| `short_clip_or_ad` | 11 | `short_slop` | clear | 100.0% (11/11) | 100.0% (10/10) |
| `borderline_listicle_or_vlog` | 17 | `brainrot` | borderline | 94.12% (16/17) | 70.0% (7/10) |
| `drama_and_gossip` | 20 | `brainrot` | clear | 100.0% (20/20) | 100.0% (10/10) |
| `viral_stunt_and_prank` | 26 | `brainrot` | clear | 100.0% (26/26) | 100.0% (10/10) |
| `compilation_slop` | 14 | `brainrot` | clear | 100.0% (14/14) | 100.0% (10/10) |
| `reaction_slop` | 8 | `brainrot` | clear | 100.0% (8/8) | 100.0% (8/8) |
| `mukbang_and_mystery_box` | 14 | `brainrot` | clear | 100.0% (14/14) | 100.0% (10/10) |
| `crypto_and_gadget_hype` | 16 | `brainrot` | clear | 100.0% (16/16) | 100.0% (10/10) |
| `asmr_sleep_slop` | 6 | `brainrot` | clear | 100.0% (6/6) | 100.0% (6/6) |

## Live Evaluation Results (`gemini-3.5-flash-lite` = Shipped Default)

### 1. Full 276-Video Real YouTube Benchmark (Full Metadata)

```sh
npx tsx scripts/eval-judge.ts --save
```

- **Model:** `gemini-3.5-flash-lite` (matches `DEFAULT_MODEL` in [`server/judge.ts`](../server/judge.ts))
- **Stage 1 deterministic pre-filter ($0):** Filtered **29 / 276** videos (**0** false kills on all 144 educational videos)
- **Stage 2 Gemini canonical judge:** Evaluated **247** survivors (`minScore >= 6`, `hideBrainrot: true`, `skipEnrichment: true`)

| Slice | n | Accuracy | Wilson 95% CI | Precision | Recall | F1 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| **Overall** | **276** | **99.28%** (274/276) | **[97.40%, 99.80%]** | **99.31%** (143 TP, 1 FP) | **99.31%** (143 TP, 1 FN) | **0.9931** |
| **Clear** | 210 | 99.52% (209/210) | [97.35%, 99.92%] | 100.0% (94 TP, 0 FP) | 98.95% (94 TP, 1 FN) | 0.9947 |
| **Borderline** | 66 | 98.48% (65/66) | [91.90%, 99.73%] | 98.00% (49 TP, 1 FP) | 100.0% (49 TP, 0 FN) | 0.9899 |

**All 2 misclassifications (both on the exact 5/6 score boundary):**
1. **FN (`4gBAjbeUrjU`):** *"The Science of Cooking :: Episode 1 :: Get Fresh"* (5m41s, placeholder description `"Description."`) — scored `5/10, brainrot=false`.
2. **FP (`ujcfxNpnHQ4`):** *"My minimal mac desk setup for productivity + creativity | Affordable, aesthetic, functional"* (6m05s, references Dr. Andrew Huberman focus tips in description) — scored `6/10, brainrot=false`.

### 2. Blinded Title-Only Stress Test (115 Stratified Real Videos)

Strips all descriptions and replaces every channel name with `"Channel"` so the judge cannot rely on creator reputation or description cues:

```sh
npx tsx scripts/eval-judge.ts --blind --per-archetype 10 --delay-ms 4000
```

| Slice | n | Accuracy | Wilson 95% CI | Precision | Recall | F1 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| **Overall (blind)** | **115** | **97.39%** (112/115) | **[92.61%, 99.11%]** | **91.18%** (31 TP, 3 FP) | **100.0%** (31 TP, 0 FN) | **0.9538** |
| **Clear (blind)** | 88 | 100.0% (88/88) | [95.82%, 100.0%] | 100.0% (14 TP, 0 FP) | 100.0% (14 TP, 0 FN) | 1.0000 |
| **Borderline (blind)** | 27 | 88.89% (24/27) | [71.94%, 96.15%] | 85.00% (17 TP, 3 FP) | 100.0% (17 TP, 0 FN) | 0.9189 |

The 3 blind false positives (`C15zACA4JSo` Top-15 listicle, `ygt3i9QiWPg` laptop review, `zUsVECiTpNA` ShortCircuit gadget unboxing) all flipped from 6/10 → ≤ 5/10 when real channel names and descriptions were present, demonstrating the concrete value of feeding authoritative descriptions and transcript excerpts to the judge.

## CI Deterministic & Regression Guard (`npm test`)

Every PR runs [`test/eval-benchmark.test.ts`](../test/eval-benchmark.test.ts) with zero API keys required, verifying:
- **100% educational recall** through Stage 1 deterministic rules across both the 276-video real YouTube benchmark (`real-youtube-benchmark.json`) and the 330-video adversarial edge-case suite (`video-benchmark.json`)
- **0 false kills** on journalism/science/history titles (`"Chernobyl: A Safety Test Gone Wrong"`, `"The Truth About Inflation"`, `"Exposed: How Enron Hid Its Debt"`, `"The Feud That Created Modern Physics: Newton vs Leibniz"`, `"I Spent 100 Hours Learning Rust"`)
- **Zero-key clickbait guard**, canonical quality floor (`baseScore <= 5` capped at `5.5`, upward delta ≤ `+1.5`), prompt-injection neutralization, batch safety-block bisection + negative caching + non-zero failure billing, platform-gated IP extraction, stale-while-revalidate caching, bounded YouTube gate queueing, incremental `channel_subscribers` indexing, and finite thin-edition locking
