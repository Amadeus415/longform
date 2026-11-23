import type { NewsSource } from "./types";

// Zero-cost, no-API-key starter packs: public Bluesky accounts, RSS/Atom feeds, and Hacker News.
// Every source here is verified live and free to read without credentials.

export type NewsPack = { name: string; about: string; sources: NewsSource[] };

const bsky = (handle: string, title: string): NewsSource => ({
  id: `bsky:${handle}`,
  kind: "bsky",
  title,
  handle: `@${handle}`,
  siteUrl: `https://bsky.app/profile/${handle}`,
});

const rss = (url: string, title: string, siteUrl?: string): NewsSource => ({
  id: `rss:${url}`,
  kind: "rss",
  title,
  siteUrl,
});

const hn = (ref: "front_page" | "show" | "ask", title: string): NewsSource => ({
  id: `hn:${ref}`,
  kind: "hn",
  title,
  siteUrl: "https://news.ycombinator.com",
});

export const NEWS_STARTER_PACKS: NewsPack[] = [
  {
    name: "World & Markets",
    about: "Wire services and major desks, stripped of the noise",
    sources: [
      bsky("reuters.com", "Reuters"),
      bsky("apnews.com", "Associated Press"),
      bsky("bloomberg.com", "Bloomberg News"),
      bsky("financialtimes.com", "Financial Times"),
      bsky("nytimes.com", "New York Times"),
      bsky("wsj.com", "Wall Street Journal"),
      rss("https://feeds.bbci.co.uk/news/world/rss.xml", "BBC World", "https://www.bbc.com/news/world"),
      rss("https://feeds.npr.org/1001/rss.xml", "NPR News", "https://www.npr.org"),
    ],
  },
  {
    name: "AI & Engineering",
    about: "Labs, researchers, and builders sharing what actually changed",
    sources: [
      bsky("simonwillison.net", "Simon Willison"),
      bsky("emollick.bsky.social", "Ethan Mollick"),
      bsky("natolambert.bsky.social", "Nathan Lambert"),
      rss("https://openai.com/news/rss.xml", "OpenAI News", "https://openai.com/news"),
      rss("https://deepmind.google/blog/rss.xml", "Google DeepMind", "https://deepmind.google/blog"),
      rss("https://huggingface.co/blog/feed.xml", "Hugging Face", "https://huggingface.co/blog"),
      hn("front_page", "Hacker News"),
    ],
  },
  {
    name: "Tech & Industry",
    about: "Independent tech reporting and sharp analysis",
    sources: [
      bsky("theverge.com", "The Verge"),
      bsky("arstechnica.com", "Ars Technica"),
      bsky("techcrunch.com", "TechCrunch"),
      bsky("404media.co", "404 Media"),
      bsky("caseynewton.bsky.social", "Casey Newton"),
      rss("https://stratechery.com/feed/", "Stratechery", "https://stratechery.com"),
      rss("https://newsletter.pragmaticengineer.com/feed", "Pragmatic Engineer", "https://newsletter.pragmaticengineer.com"),
      rss("https://daringfireball.net/feeds/main", "Daring Fireball", "https://daringfireball.net"),
    ],
  },
  {
    name: "Science & Ideas",
    about: "Research, economics, and deeper reporting",
    sources: [
      rss("https://www.quantamagazine.org/feed/", "Quanta Magazine", "https://www.quantamagazine.org"),
      rss("https://www.nature.com/nature.rss", "Nature", "https://www.nature.com"),
      bsky("wired.com", "WIRED"),
      bsky("economist.com", "The Economist"),
      bsky("pkrugman.bsky.social", "Paul Krugman"),
    ],
  },
];
