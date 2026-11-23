import { describe, expect, it } from "vitest";
import { isSafeHttpUrl, parseSourceId, parseXmlFeed, stripHtml } from "../server/news";
import { buildDailyBrief, canonicalizeUrl } from "../src/lib/brief";
import { parseOpml } from "../src/lib/newsFeed";
import { applyNewsRules, DEFAULT_NEWS_RULES, describeNewsChanges, judgeNews, normalizeNewsRules, type NewsRules } from "../src/lib/newsFilter";
import type { NewsItem } from "../src/lib/types";

const NOW = Date.parse("2026-11-22T18:00:00Z");
const ctx = { now: NOW, read: new Set<string>() };
const rules: NewsRules = { ...DEFAULT_NEWS_RULES };

function item(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: "bsky:at://did:plc:1/app.bsky.feed.post/abc",
    sourceId: "bsky:reuters.com",
    sourceTitle: "Reuters",
    sourceKind: "bsky",
    author: "Reuters",
    handle: "@reuters.com",
    title: "Federal Reserve holds interest rates steady amid cooling inflation data",
    text: "Federal Reserve officials voted unanimously to hold benchmark rates unchanged while signaling patience on future cuts.",
    url: "https://www.reuters.com/markets/fed-holds-rates-2026",
    published: "2026-11-22T16:00:00Z",
    ...overrides,
  };
}

describe("judgeNews", () => {
  it("shows a fresh, substantive original post", () => {
    expect(judgeNews(item(), rules, ctx)).toEqual({ show: true });
  });

  it("hides reposts and replies when configured", () => {
    expect(judgeNews(item({ isRepost: true }), rules, ctx)).toMatchObject({ show: false, rule: "hideReposts", reason: "Repost" });
    expect(judgeNews(item({ isReply: true }), rules, ctx)).toMatchObject({ show: false, rule: "hideReplies", reason: "Reply" });
    expect(judgeNews(item({ isRepost: true }), { ...rules, hideReposts: false }, ctx)).toEqual({ show: true });
  });

  it("hides posts outside the time window", () => {
    const old = item({ published: "2026-11-20T12:00:00Z" });
    expect(judgeNews(old, rules, ctx)).toMatchObject({ show: false, rule: "maxAgeHours" });
    expect(judgeNews(old, { ...rules, maxAgeHours: 72 }, ctx)).toEqual({ show: true });
  });

  it("hides short reactions and engagement-bait words unless allowed", () => {
    expect(judgeNews(item({ title: "Wild!", text: "Wild!" }), rules, ctx)).toMatchObject({ show: false, rule: "minChars" });
    const bait = item({ title: "Unpopular opinion: AI agents will change everything this year" });
    expect(judgeNews(bait, rules, ctx)).toMatchObject({ show: false, rule: "hideWords", reason: "Contains “unpopular opinion”" });
    expect(judgeNews(bait, { ...rules, allowWords: ["AI agents"] }, ctx)).toEqual({ show: true });
  });

  it("hides read items when hideRead is on", () => {
    const readCtx = { now: NOW, read: new Set([item().id]) };
    expect(judgeNews(item(), rules, readCtx)).toMatchObject({ show: false, rule: "hideRead" });
    expect(judgeNews(item(), { ...rules, hideRead: false }, readCtx)).toEqual({ show: true });
  });
});

describe("applyNewsRules & rule helpers", () => {
  it("sorts newest first, dedupes, and stays deterministic", () => {
    const items = [
      item({ id: "a", published: "2026-11-22T14:00:00Z" }),
      item({ id: "b", published: "2026-11-22T17:00:00Z" }),
      item({ id: "c", isRepost: true }),
      item({ id: "b", published: "2026-11-22T17:00:00Z" }),
    ];
    const res = applyNewsRules(items, rules, ctx);
    expect(res.shown.map((i) => i.id)).toEqual(["b", "a"]);
    expect(res.hidden.map((h) => h.item.id)).toEqual(["c"]);
    expect(applyNewsRules([...items].reverse(), rules, ctx)).toEqual(res);
  });

  it("describes changes and normalizes messy input", () => {
    const after: NewsRules = { ...rules, maxAgeHours: 48, hideReposts: false, hideWords: [...rules.hideWords, "drama"] };
    expect(describeNewsChanges(rules, after)).toEqual(["Window: 24 hours → 2 days", "Hide reposts: on → off", "Hide + “drama”"]);
    expect(normalizeNewsRules(null)).toEqual(DEFAULT_NEWS_RULES);
    expect(normalizeNewsRules({ maxAgeHours: -2, minChars: 120, hideReposts: "no" })).toMatchObject({
      maxAgeHours: DEFAULT_NEWS_RULES.maxAgeHours,
      minChars: 120,
      hideReposts: DEFAULT_NEWS_RULES.hideReposts,
    });
  });
});

describe("buildDailyBrief", () => {
  it("clusters multi-source coverage of the same event and keeps unrelated posts as insights", () => {
    const reuters = item({
      id: "r1",
      sourceId: "bsky:reuters.com",
      sourceTitle: "Reuters",
      title: "Federal Reserve holds interest rates steady at 4.25% amid cooling inflation",
      text: "Federal Reserve officials held interest rates steady at 4.25% on Wednesday. Chair Powell pointed to steady progress on core inflation.",
      url: "https://reuters.com/markets/fed-rates",
      published: "2026-11-22T17:30:00Z",
    });
    const bloomberg = item({
      id: "b1",
      sourceId: "bsky:bloomberg.com",
      sourceTitle: "Bloomberg News",
      title: "Federal Reserve holds interest rates steady at 4.25% as Treasury yields dip",
      text: "Treasuries rallied after the Federal Reserve held interest rates steady at 4.25% and kept two cuts in the dot plot.",
      url: "https://bloomberg.com/news/fed-rates-steady",
      published: "2026-11-22T17:15:00Z",
    });
    const simon = item({
      id: "s1",
      sourceId: "bsky:simonwillison.net",
      sourceTitle: "Simon Willison",
      title: "Notes on running SQLite full-text search inside WebAssembly",
      text: "I benchmarked SQLite FTS5 compiled to WASM on a 50MB corpus and got sub-5ms prefix queries right in the browser.",
      url: "https://simonwillison.net/2026/Nov/22/sqlite-wasm",
      published: "2026-11-22T16:45:00Z",
    });

    const brief = buildDailyBrief([reuters, bloomberg, simon]);
    expect(brief.events).toHaveLength(1);
    expect(brief.events[0].sources.map((s) => s.title).sort()).toEqual(["Bloomberg News", "Reuters"]);
    expect(brief.events[0].items).toHaveLength(2);
    expect(brief.insights.map((i) => i.id)).toEqual(["s1"]);
  });

  it("clusters two posts sharing the same canonical URL even with different wording", () => {
    const a = item({
      id: "u1",
      sourceId: "hn:front_page",
      sourceTitle: "Hacker News",
      title: "Show HN: Minimalist local-first SQLite browser",
      text: "Show HN: Minimalist local-first SQLite browser",
      url: "https://example.dev/sqlite-tool/?utm_source=hn",
    });
    const b = item({
      id: "u2",
      sourceId: "bsky:simonwillison.net",
      sourceTitle: "Simon Willison",
      title: "Great new open-source database inspector",
      text: "Really impressed by how fast this browser-based inspector feels on huge files.",
      url: "https://www.example.dev/sqlite-tool",
    });
    const brief = buildDailyBrief([a, b]);
    expect(brief.events).toHaveLength(1);
    expect(brief.events[0].items).toHaveLength(2);
    expect(canonicalizeUrl(a.url)).toBe("example.dev/sqlite-tool");
  });
});

describe("server news parsers & OPML", () => {
  it("validates source IDs and blocks private network URLs", () => {
    expect(parseSourceId("bsky:reuters.com")).toEqual({ kind: "bsky", ref: "reuters.com" });
    expect(parseSourceId("hn:front_page")).toEqual({ kind: "hn", ref: "front_page" });
    expect(parseSourceId("rss:https://example.com/feed.xml")).toEqual({ kind: "rss", ref: "https://example.com/feed.xml" });
    expect(parseSourceId("rss:http://127.0.0.1:8080/secret")).toBeNull();
    expect(isSafeHttpUrl("http://192.168.1.5/feed")).toBe(false);
    expect(isSafeHttpUrl("http://localhost:3000/rss")).toBe(false);
    expect(isSafeHttpUrl("https://feeds.bbci.co.uk/news/world/rss.xml")).toBe(true);
  });

  it("parses RSS 2.0 XML feeds cleanly", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
        <title>Example Desk</title>
        <link>https://example.com</link>
        <item>
          <guid>post-1</guid>
          <title>Clean Energy Hits Record Share</title>
          <link>https://example.com/clean-energy</link>
          <description><![CDATA[<p>Solar &amp; wind generated <b>42%</b> of power.</p>]]></description>
          <pubDate>Sun, 22 Nov 2026 15:00:00 GMT</pubDate>
        </item>
      </channel></rss>`;
    const parsed = parseXmlFeed(xml, "rss:https://example.com/rss", "https://example.com/rss");
    expect(parsed.title).toBe("Example Desk");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].text).toBe("Solar & wind generated 42% of power.");
    expect(stripHtml("<p>Hello &amp; <i>world</i></p>")).toBe("Hello & world");
  });

  it("extracts RSS sources from OPML", () => {
    const opml = `<opml version="2.0"><body>
      <outline text="Tech">
        <outline text="Stratechery" title="Stratechery" type="rss" xmlUrl="https://stratechery.com/feed/" htmlUrl="https://stratechery.com" />
        <outline text="Duplicate" xmlUrl="https://stratechery.com/feed/" />
      </outline>
    </body></opml>`;
    expect(parseOpml(opml)).toEqual([
      { id: "rss:https://stratechery.com/feed/", kind: "rss", title: "Stratechery", siteUrl: "https://stratechery.com" },
    ]);
  });
});
