import type { CanonicalCategory, LlmJudgment, PersonalScore, Video, VideoRating } from "./types";

/**
 * Deterministic, zero-cost, on-device taste personalization + topic inference + clickbait heuristic engine.
 *
 * Keeps the server's AI judge 100% shared and poison-proof across thousands of users while
 * applying each user's 1–10 ratings instantaneously on-device — even in the default
 * `scope: "discover"` config where followed videos may not have AI judgments!
 */

export type ClickbaitAnalysis = {
  /** Heuristic clickbait/ragebait risk score 0..10 (0 = clean, 10 = blatant slop/bait). */
  risk: number;
  /** Human-readable reasons that triggered, for transparency and soft LLM signals. */
  signals: string[];
};

const BAIT_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  // Blatant clickbait hooks
  { re: /\byou won'?t believe\b/i, weight: 3.5, label: "clickbait hook" },
  { re: /\b(?:100% real|not clickbait|no clickbait|3\s*am challenge|impossible edition)\b/i, weight: 4.0, label: "blatant clickbait" },
  { re: /\b(?:watch before it'?s deleted|this changes everything forever|shocking truth|they don'?t want you to know)\b/i, weight: 3.5, label: "hype/conspiracy hook" },

  // Drama, gossip, apologies & influencer beef (carefully avoiding analytical essays like "the obsession with celebrity gossip")
  { re: /\b(?:streamer|youtuber|influencer|celebrity|celebrities|twitch)\s+(?:reacts to|feud|drama|banned|apology|exposed|breakups?|scandals?|downfalls?|beef)\b/i, weight: 3.5, label: "influencer drama" },
  { re: /\b(?:worst\s+youtuber|youtuber\s+apology|apology\s+(?:video|is\s+pathetic|exposed)|leaked\s+dms?|huge\s+drama|insane\s+drama|beef\s+(?:with|just)|calling\s+out|went\s+(?:way\s+)?too\s+far|gone\s+too\s+far|nuked\s+his\s+career|hollywood\s+rumors?|(?:recent|latest|breaking)\s+celebrity\s+gossip|so\s+much\s+drama|files\s+just\s+(?:dropped|got\s+crazy)|exposed\s+(?:him|her|by)|ruins\s+case)\b/i, weight: 3.5, label: "drama/gossip bait" },
  { re: /\b(?:obliterated|humiliated|cancelled|canceled|completely destroyed|destroyed (?:by|in|his|her|their))\b/i, weight: 2.5, label: "conflict bait" },

  // Viral stunts, 24h challenges & pranks
  { re: /\b(?:last to leave|wins?\s+\$\d[\d,]*|24\s*hours?\s+overnight|overnight\s+challenge)\b/i, weight: 3.5, label: "viral challenge stunt" },
  { re: /\b(?:i spent \d+ hours (?:in|inside|trapped|buried|surviving|locked|eating|playing)|i survived \d+ hours|\$\d[\d,]*\s+vs\.?\s+\$\d[\d,]*|vs\.?\s+\d+\s+(?:kids|people|millionaires|subscribers|strangers))\b/i, weight: 3.5, label: "viral stunt format" },
  { re: /\b(?:i bought (?:a |the world'?s )?\$?\d|i paid \d+|i ate only|i tested \d+ viral|eating only .* for \d+ hours)\b/i, weight: 3.5, label: "viral stunt format" },
  { re: /\b(?:pranks?\s+gone\s+wrong|(?:funniest|best|public|bushman|gold\s+digger|fake\s+proposal|scary\s+clown)\s+pranks?|pranksters?|pranks?\s+worth\s+your|stealing\s+money.*prank)\b/i, weight: 3.5, label: "prank slop" },

  // Reaction, fail & TikTok compilations
  { re: /\b(?:try not to (?:laugh|cringe)|(?:best|epic|funny|scary)\s+fails|cringe compilation|fails compilation|instant regret|instant karma)\b/i, weight: 3.5, label: "slop compilation" },
  { re: /\b(?:tiktok\s+(?:cringe|reactions?|compilation|food\s+hacks|shopping\s+haul|drama|dances|edition)|cringefest|cringe\s+tiktoks|tik\s*tok\s+cringe)\b/i, weight: 3.5, label: "tiktok slop" },
  { re: /\b(?:my honest reaction|react(?:ing|s)?\s+to\s+(?:the\s+)?(?:funniest|worst|tik\s*toks?|funny)|you laugh,?\s+you lose|nonstop laughs|pro gamer reacts)\b/i, weight: 3.5, label: "reaction slop" },
  { re: /\b(?:best|wildest|funny)\s+[\w\s]{0,20}\bcompilation\b/i, weight: 3.5, label: "compilation slop" },

  // Mukbang, mystery box gambling, ASMR sleep, crypto hype, gadget spam & lifestyle routine tours
  { re: /\b(?:mukbang|spicy\s+buldak|(?:opening|unboxing|bought\s+a?)\s+[\w\s$,]{0,24}mystery\s+box|mystery\s+box\s+unboxing|amazon\s+returns|(?:sneaker|luxury\s+watch|shopping\s+haul)\s+unboxing|unboxing\s+\$?\d)\b/i, weight: 3.5, label: "mukbang/unboxing slop" },
  { re: /\b(?:asmr\s+(?:for\s+sleep|tapping|whispering|roleplay|slime|triggers|keyboard|mukbang|good\s+ol)|(?:hours?\s+of|just|gentle)\s+asmr|tapping\s*(?:&|and)\s*scratching)\b/i, weight: 3.5, label: "sleep ASMR" },
  { re: /\b(?:(?:crypto|altcoin|memecoin)s?[\w\s]{0,30}(?:millionaires?|100x|1000x|buy\s+now|gems?)|make\s+millionaires|100x\s+[\w\s]{0,20}(?:crypto|coin|altcoin)|buying\s+these\s+\d+\s+cryptos|crypto\s+millionaire|memecoin\s+trader)\b/i, weight: 3.5, label: "crypto hype" },
  { re: /\b(?:\d+\s+(?:insane|crazy|craziest|coolest|wild|weird)\s+(?:amazon\s+|tech\s+)?gadgets|gadgets\s+you\s+(?:need|must|didn'?t\s+know))\b/i, weight: 3.5, label: "affiliate gadget listicle" },
  { re: /\b(?:(?:day|week)\s+in\s+(?:the|my)\s+life|(?:minimal(?:ist|istic)?|productivity|home\s+office)\s+(?:mac\s+)?(?:desk|workspace)\s+(?:setup|tour))\b/i, weight: 3.5, label: "lifestyle routine vlog" },
];

/**
 * Fast, deterministic clickbait/ragebait detector for titles.
 */
export function analyzeClickbait(title: string): ClickbaitAnalysis {
  const clean = title.trim();
  if (!clean) return { risk: 0, signals: [] };

  let risk = 0;
  const signals: string[] = [];

  for (const p of BAIT_PATTERNS) {
    if (p.re.test(clean)) {
      risk += p.weight;
      if (!signals.includes(p.label)) signals.push(p.label);
    }
  }

  // Excessive ALL-CAPS words (ignore 2-4 char acronyms like AI, USA, MIT, NASA, LLM, GPU, CPU, DNA, WWII, FED).
  const words = clean.split(/\s+/).filter(Boolean);
  const longWords = words.filter((w) => w.replace(/[^a-zA-Z]/g, "").length >= 5);
  const shoutWords = longWords.filter((w) => {
    const letters = w.replace(/[^a-zA-Z]/g, "");
    return letters.length >= 5 && letters === letters.toUpperCase();
  });
  if (shoutWords.length >= 2 || (longWords.length >= 3 && shoutWords.length / longWords.length >= 0.4)) {
    risk += 2.0;
    signals.push("ALL-CAPS shouting");
  }

  if (/[!?]{2,}|!\?|\?!/.test(clean)) {
    risk += 1.5;
    signals.push("sensational punctuation");
  }

  const baitEmojis = clean.match(/[😱🤯💀🔥🤡🚨😡🤬💥👀]/gu);
  if (baitEmojis && baitEmojis.length >= 2) {
    risk += 1.5;
    signals.push("hype emojis");
  }

  return {
    risk: Math.min(10, Math.round(risk * 10) / 10),
    signals,
  };
}

// ---------- Deterministic zero-cost topic classifier (maps to CANONICAL_CATEGORIES) ----------

const TOPIC_RULES: Array<{ category: CanonicalCategory; re: RegExp }> = [
  {
    category: "AI & Tech",
    re: /\b(?:llm|gpt|transformer architecture|attention mechanism|neural network|machine learning|deep learning|ai safety|compiler|rust programming|in rust|learning rust|rust compiler|linux|kernel|postgres|postgresql|sqlite|database|algorithm|cryptography|distributed systems|kubernetes|cpu|gpu|software engineering|programming|git|http|tcp|dns|unix|cs50|cs229|cs149|cs162)\b/i,
  },
  {
    category: "Science",
    re: /\b(?:quantum|physics|relativity|black hole|astronomy|telescope|james webb|fusion|nuclear|biology|dna|crispr|mrna|chemistry|chemical|thermodynamics|mathematics|math|eigenvalue|fourier|linear algebra|prime number|geology|volcano|climate|evolution|neuroscience|nasa|science)\b/i,
  },
  {
    category: "Engineering",
    re: /\b(?:engineering|bridge|concrete|semiconductor|lithography|tsmc|jet engine|rocket|submarine|aircraft|boeing|battery|electric motor|solar|hvdc|fiber optic|aerodynamics|structural|manufacturing|canal lock|canal|power grid|electrical grid|reactor)\b/i,
  },
  {
    category: "History",
    re: /\b(?:history|historical|empire|roman|byzantine|medieval|renaissance|bronze age|industrial revolution|mesopotamia|bletchley|victorian|ancient|world war|wwii|ww2|ww1|cold war|civil war|vietnam war|napoleon|ottoman|dynasty|civilization|apollo|century)\b/i,
  },
  {
    category: "Finance",
    re: /\b(?:federal reserve|interest rate|inflation|gold standard|portfolio|index fund|central bank|monetary|treasury bond|bond yield|bond market|municipal bond|corporate bond|stock market|etf|macroeconomic|financial market|wall street|investing)\b/i,
  },
  {
    category: "Business",
    re: /\b(?:business|startup|founder|company|strategy|supply chain|economics|economic|trade policy|foundry|costco|nvidia|vc|venture capital|enterprise)\b/i,
  },
  {
    category: "Health",
    re: /\b(?:sleep|cardiovascular|medicine|medical|vaccine|immune|circadian|physiology|surgery|antibiotic|health|nutrition|longevity|clinical|doctor)\b/i,
  },
  {
    category: "Philosophy",
    re: /\b(?:philosophy|ethics|epistemology|consciousness|logic|stoic|moral|existential|metaphysics)\b/i,
  },
  {
    category: "Design",
    re: /\b(?:game design|architecture|typography|industrial design|ui design|ux|cinema|film history|music theory|design)\b/i,
  },
  {
    category: "Society",
    re: /\b(?:constitutional|law|policy|geopolitics|governance|democracy|regulation|labor|urban|demographics)\b/i,
  },
];

/**
 * Infer a canonical topic category deterministically from title & channel when an AI category
 * is absent (so rating followed videos immediately feeds on-device Discover personalization!).
 */
export function inferCategory(title: string, channel = ""): CanonicalCategory | undefined {
  const haystack = `${title} ${channel}`.trim();
  if (!haystack) return undefined;
  for (const rule of TOPIC_RULES) {
    if (rule.re.test(haystack)) return rule.category;
  }
  return undefined;
}

function durationBucket(seconds: number | null | undefined): "concise" | "medium" | "long" | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 1200) return "concise"; // < 20m
  if (seconds < 3600) return "medium"; // 20–60m
  return "long"; // 60m+
}

export type TasteProfile = {
  ratingCount: number;
  meanUserScore: number;
  /** Damped (user - AI) bias when paired ratings exist; negative means user rates stricter than AI. */
  aiBias: number;
  /** Per-channel affinity adjustment (-1.5 .. +1.5), keyed by channelId and lowercase channel name. */
  channelAffinity: Map<string, { delta: number; count: number; avg: number; label: string }>;
  /** Per-category affinity adjustment (-1.0 .. +1.0), keyed by lowercase canonical category. */
  categoryAffinity: Map<string, { delta: number; count: number; avg: number; label: string }>;
  /** Per-duration-bucket affinity adjustment (-0.5 .. +0.5). */
  lengthAffinity: Map<string, { delta: number; count: number; label: string }>;
  /** Extra penalty multiplier (0..1) if user dislikes clickbait/ragebait-flagged videos. */
  clickbaitSensitivity: number;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const LENGTH_LABELS: Record<string, string> = {
  concise: "Under 20m",
  medium: "20–60m",
  long: "1h+",
};

/**
 * Build a compact, deterministic taste profile from the user's 1–10 ratings.
 * Works immediately even when rating followed videos with no AI judgment (via `inferCategory` + duration bucket + channel affinity).
 */
export function buildTasteProfile(ratings: Readonly<Record<string, VideoRating>> | undefined): TasteProfile {
  const list = ratings ? Object.values(ratings) : [];
  const channelAffinity = new Map<string, { delta: number; count: number; avg: number; label: string }>();
  const categoryAffinity = new Map<string, { delta: number; count: number; avg: number; label: string }>();
  const lengthAffinity = new Map<string, { delta: number; count: number; label: string }>();

  if (!list.length) {
    return {
      ratingCount: 0,
      meanUserScore: 7,
      aiBias: 0,
      channelAffinity,
      categoryAffinity,
      lengthAffinity,
      clickbaitSensitivity: 0.25,
    };
  }

  const meanUserScore = list.reduce((sum, r) => sum + r.score, 0) / list.length;

  // 1. User vs AI global bias (damped with prior strength 6).
  let pairedDiffSum = 0;
  let pairedCount = 0;
  for (const r of list) {
    if (typeof r.aiScore === "number") {
      pairedDiffSum += r.score - r.aiScore;
      pairedCount++;
    }
  }
  const rawBias = pairedCount >= 3 ? pairedDiffSum / (pairedCount + 6) : 0;
  const aiBias = round1(clamp(rawBias, -1.5, 1.5));

  // Anchor affinity deviations around a neutral 6.5 (blended slightly with user's mean so all-low or all-high
  // ratings still produce clear negative/positive signals instead of cancelling out to zero!).
  const baseline = 6.5 * 0.65 + clamp(meanUserScore, 4.5, 8.5) * 0.35;

  // 2. Per-channel affinity (shrunk with k=3, capped at ±1.5 points).
  const byCh = new Map<string, { sum: number; count: number; label: string; altKey?: string }>();
  for (const r of list) {
    const key = r.channelId || r.channel.trim().toLowerCase();
    if (!key) continue;
    const altKey = r.channel.trim().toLowerCase();
    const cur = byCh.get(key) ?? { sum: 0, count: 0, label: r.channel || key, altKey };
    cur.sum += r.score;
    cur.count += 1;
    byCh.set(key, cur);
  }
  for (const [key, entry] of byCh) {
    const avg = entry.sum / entry.count;
    const shrunk = ((avg - baseline) * entry.count) / (entry.count + 3);
    const delta = round1(clamp(shrunk * 0.75, -1.5, 1.5));
    if (Math.abs(delta) >= 0.1) {
      const info = { delta, count: entry.count, avg: round1(avg), label: entry.label };
      channelAffinity.set(key, info);
      if (entry.altKey && !channelAffinity.has(entry.altKey)) {
        channelAffinity.set(entry.altKey, info);
      }
    }
  }

  // 3. Per-category affinity (uses `aiCategory` OR zero-cost `inferCategory(title, channel)`!).
  const byCat = new Map<string, { sum: number; count: number; label: string }>();
  for (const r of list) {
    const cat = r.aiCategory?.trim() || inferCategory(r.title, r.channel);
    if (!cat) continue;
    const key = cat.toLowerCase();
    const cur = byCat.get(key) ?? { sum: 0, count: 0, label: cat };
    cur.sum += r.score;
    cur.count += 1;
    byCat.set(key, cur);
  }
  for (const [key, entry] of byCat) {
    const avg = entry.sum / entry.count;
    const shrunk = ((avg - baseline) * entry.count) / (entry.count + 3);
    const delta = round1(clamp(shrunk * 0.65, -1.2, 1.2));
    if (Math.abs(delta) >= 0.1) {
      categoryAffinity.set(key, { delta, count: entry.count, avg: round1(avg), label: entry.label });
    }
  }

  // 4. Per-duration-bucket affinity (capped at ±0.5 so length gently tunes Discover without dominating quality).
  const byLen = new Map<string, { sum: number; count: number }>();
  for (const r of list) {
    const b = durationBucket(r.seconds);
    if (!b) continue;
    const cur = byLen.get(b) ?? { sum: 0, count: 0 };
    cur.sum += r.score;
    cur.count += 1;
    byLen.set(b, cur);
  }
  for (const [key, entry] of byLen) {
    if (entry.count < 2) continue;
    const avg = entry.sum / entry.count;
    const shrunk = ((avg - baseline) * entry.count) / (entry.count + 5);
    const delta = round1(clamp(shrunk * 0.3, -0.5, 0.5));
    if (Math.abs(delta) >= 0.1) {
      lengthAffinity.set(key, { delta, count: entry.count, label: LENGTH_LABELS[key] ?? key });
    }
  }

  // 5. Clickbait sensitivity.
  let baitLow = 0;
  let baitTotal = 0;
  for (const r of list) {
    const cb = analyzeClickbait(r.title);
    if (cb.risk >= 2.5 || r.aiBrainrot) {
      baitTotal++;
      if (r.score <= 4) baitLow++;
    }
  }
  const clickbaitSensitivity = baitTotal >= 2 ? clamp(0.25 + (baitLow / baitTotal) * 0.5, 0.2, 0.75) : 0.25;

  return {
    ratingCount: list.length,
    meanUserScore: round1(meanUserScore),
    aiBias,
    channelAffinity,
    categoryAffinity,
    lengthAffinity,
    clickbaitSensitivity,
  };
}

/**
 * Compute an explainable personalized score (1..10) for a video by combining:
 * - the shared canonical AI judgment (baseScore + clickbait/ragebait dimensions), and
 * - the user's on-device TasteProfile derived from their 1–10 ratings.
 *
 * Includes a canonical floor: positive bias/affinities can NEVER lift low-quality or borderline videos
 * (`baseScore <= 5` or `brainrot === true`) above 5.5 unless the user explicitly rated that exact video,
 * and upward personalization is capped at +1.5 (downward at -2.5).
 */
export function computePersonalScore(
  video: Pick<Video, "id" | "title" | "channel" | "channelId"> & { seconds?: number | null },
  judgment: LlmJudgment,
  profile: TasteProfile,
  directRating?: VideoRating,
): PersonalScore {
  const baseScore = judgment.score;
  const breakdown: string[] = [];
  let delta = 0;

  if (directRating) {
    return {
      effectiveScore: directRating.score,
      baseScore,
      delta: round1(directRating.score - baseScore),
      breakdown: [`Your rating ${directRating.score}/10`],
      isDirectRating: true,
    };
  }

  if (profile.aiBias !== 0) {
    delta += profile.aiBias;
    breakdown.push(`Bias ${profile.aiBias > 0 ? "+" : ""}${profile.aiBias.toFixed(1)}`);
  }

  const chInfo =
    (video.channelId ? profile.channelAffinity.get(video.channelId) : undefined) ??
    (video.channel ? profile.channelAffinity.get(video.channel.trim().toLowerCase()) : undefined);
  if (chInfo) {
    delta += chInfo.delta;
    breakdown.push(`${chInfo.label} ${chInfo.delta > 0 ? "+" : ""}${chInfo.delta.toFixed(1)}`);
  }

  const resolvedCat = judgment.category?.trim() || inferCategory(video.title, video.channel);
  if (resolvedCat) {
    const catInfo = profile.categoryAffinity.get(resolvedCat.toLowerCase());
    if (catInfo) {
      delta += catInfo.delta;
      breakdown.push(`${catInfo.label} ${catInfo.delta > 0 ? "+" : ""}${catInfo.delta.toFixed(1)}`);
    }
  }

  const lenKey = durationBucket(video.seconds);
  if (lenKey) {
    const lenInfo = profile.lengthAffinity.get(lenKey);
    if (lenInfo) {
      delta += lenInfo.delta;
      breakdown.push(`${lenInfo.label} ${lenInfo.delta > 0 ? "+" : ""}${lenInfo.delta.toFixed(1)}`);
    }
  }

  const cbScore = typeof judgment.clickbait === "number" ? judgment.clickbait : 0;
  const rbScore = typeof judgment.ragebait === "number" ? judgment.ragebait : 0;
  if (cbScore >= 7) {
    const pen = -round1((cbScore - 6) * 0.25 * (1 + profile.clickbaitSensitivity));
    if (pen <= -0.2) {
      delta += pen;
      breakdown.push(`Clickbait ${pen.toFixed(1)}`);
    }
  }
  if (rbScore >= 6) {
    const pen = -round1((rbScore - 5) * 0.35);
    if (pen <= -0.2) {
      delta += pen;
      breakdown.push(`Ragebait ${pen.toFixed(1)}`);
    }
  }

  const clampedDelta = round1(clamp(delta, -2.5, 1.5));
  let effectiveScore = round1(clamp(baseScore + clampedDelta, 1, 10));

  // Canonical quality floor: never let lenient rating bias promote brainrot or <=5/10 borderline/low videos above 5.5.
  if ((baseScore <= 5 || judgment.brainrot) && effectiveScore > 5.5) {
    effectiveScore = 5.5;
  }

  return {
    effectiveScore,
    baseScore,
    delta: round1(effectiveScore - baseScore),
    breakdown,
    isDirectRating: false,
  };
}
