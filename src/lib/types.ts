// Shared between the server (which produces these) and the app (which filters them).

export type Chapter = [seconds: number, title: string];

export type Video = {
  id: string;
  title: string;
  channelId: string;
  channel: string;
  published: string; // ISO date
  seconds: number | null; // null = unknown (e.g. an upcoming premiere)
  chapters?: Chapter[];
};

export type ChannelFeed = {
  id: string;
  title: string;
  videos: Video[];
  fetchedAt: number;
};

export type ChannelHit = {
  id: string;
  title: string;
  handle?: string;
  subscribers?: string;
  thumbnail?: string;
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
