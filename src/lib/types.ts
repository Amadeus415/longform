// Shared between the server (which produces these) and the app (which filters them).

export type Chapter = [seconds: number, title: string];

export const CANONICAL_CATEGORIES = [
  "AI & Tech",
  "Science",
  "Engineering",
  "History",
  "Business",
  "Finance",
  "Health",
  "Philosophy",
  "Culture",
  "Society",
  "Design",
  "Education",
  "Entertainment",
  "Drama",
  "Clickbait",
] as const;

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

export type Video = {
  id: string;
  title: string;
  channelId: string;
  channel: string;
  published: string; // ISO date (empty string when unknown)
  seconds: number | null; // null = unknown (e.g. length lookup failed or upcoming premiere)
  chapters?: Chapter[];
  description?: string; // concise snippet for LLM educational judge context
  /** True when fetched from YouTube's UULF long-form playlist (which already excludes Shorts and live streams). */
  fromLongFormFeed?: boolean;
  source?: "following" | "discover";
  recommendedVia?: "home" | "related";
  recommendedReason?: string;
  recommendedScore?: number;
};

export type VideoFormat =
  | "explainer"
  | "lecture"
  | "interview"
  | "documentary"
  | "analysis"
  | "tutorial"
  | "commentary"
  | "entertainment"
  | "slop";

export type LlmJudgment = {
  videoId: string;
  rubricHash: string;
  score: number; // 1..10 overall educational / signal score
  brainrot: boolean;
  /** Optional multi-dimensional signal scores from canonical judge (1..10). */
  depth?: number;
  clickbait?: number;
  ragebait?: number;
  format?: VideoFormat;
  category?: string;
  reason: string;
  model: string;
  judgedAt: number;
};

export type PersonalScore = {
  effectiveScore: number;
  baseScore: number;
  delta: number;
  breakdown: string[];
  isDirectRating: boolean;
};

export type VideoRating = {
  videoId: string;
  score: number; // integer 1..10
  ratedAt: number;
  note?: string;
  title: string;
  channel: string;
  channelId: string;
  published?: string;
  seconds: number | null;
  source?: "following" | "discover";
  aiScore?: number;
  aiBrainrot?: boolean;
  aiCategory?: string;
  aiReason?: string;
};

export type CalibrationExample = {
  title: string;
  channel: string;
  userScore: number;
  aiScore?: number;
  note?: string;
  seconds?: number | null;
  source?: "following" | "discover";
};

export type DiscoverFeed = {
  mode: "home" | "related";
  /** Calendar day key ("YYYY-MM-DD") for calm daily edition cadence. */
  editionDay?: string;
  /** Fixed set of video IDs locked for today's edition so finishing/rating one never backfills more. */
  lockedEditionIds?: string[];
  hasCookie: boolean;
  cookieSource?: "user" | "env" | "none";
  fallbackReason?: string;
  videos: Video[];
  fetchedAt: number;
};

export type ChannelFeed = {
  id: string;
  title: string;
  videos: Video[];
  fetchedAt: number;
  /** True when serving cached data after an upstream YouTube error/429. */
  stale?: boolean;
};

export type ChannelHit = {
  id: string;
  title: string;
  handle?: string;
  subscribers?: string;
  thumbnail?: string;
};

/** Deletion timestamps for tombstone-safe multi-device sync. */
export type SyncTombstones = {
  channels: Record<string, number>;
  blockedChannels: Record<string, number>;
  ratings: Record<string, number>;
  newsSources: Record<string, number>;
};

// ---------- news & social ----------

export type NewsSourceKind = "bsky" | "rss" | "hn";

export type NewsSource = {
  /** Deterministic ID: "bsky:reuters.com", "rss:https://...", or "hn:front_page". */
  id: string;
  kind: NewsSourceKind;
  title: string;
  handle?: string;
  siteUrl?: string;
  avatar?: string;
  addedAt?: number;
};

export type NewsItem = {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceKind: NewsSourceKind;
  author: string;
  handle?: string;
  /** Short headline (RSS title, HN title, embedded link title, or first sentence of a social post). */
  title: string;
  /** Plain-text body / summary, stripped of HTML. */
  text: string;
  /** Primary URL to open (linked article or original post). */
  url: string;
  /** Secondary link (e.g. Bluesky post or HN thread when `url` is an external article). */
  discussionUrl?: string;
  domain?: string;
  published: string; // ISO date
  isRepost?: boolean;
  isReply?: boolean;
  quotedText?: string;
  quotedAuthor?: string;
};

export type NewsSourceFeed = {
  id: string;
  kind: NewsSourceKind;
  title: string;
  handle?: string;
  siteUrl?: string;
  avatar?: string;
  items: NewsItem[];
  fetchedAt: number;
};

export type NewsSourceHit = {
  id: string;
  kind: NewsSourceKind;
  title: string;
  handle?: string;
  about?: string;
  siteUrl?: string;
  avatar?: string;
};
