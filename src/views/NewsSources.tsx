import { useEffect, useRef, useState, type FormEvent } from "react";
import { intent, navigate } from "../lib/nav";
import { openExternalUrl } from "../lib/native";
import { findNewsSources, parseOpml, refreshNews } from "../lib/newsFeed";
import { NEWS_STARTER_PACKS } from "../lib/newsStarter";
import { addNewsSources, removeNewsSource, useStore } from "../lib/store";
import type { NewsSource, NewsSourceHit } from "../lib/types";
import { Icon, NewsAvatar, ago, showActions, toast } from "./ui";

const KIND_LABEL: Record<NewsSource["kind"], string> = {
  bsky: "Bluesky",
  rss: "RSS",
  hn: "Hacker News",
};

export function NewsSources() {
  const sources = useStore((s) => s.newsSources);
  const feeds = useStore((s) => s.newsFeeds);
  const have = new Set(sources.map((s) => s.id));
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NewsSourceHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const opmlInput = useRef<HTMLInputElement>(null);

  const add = (list: NewsSource[]) => {
    const added = addNewsSources(list);
    toast(added ? `Following ${added === 1 ? list[0].title : `${added} sources`}` : "Already following");
    refreshNews();
  };

  const search = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const results = await findNewsSources(q);
      setHits(results);
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (intent.sourceQuery) {
      setQuery(intent.sourceQuery);
      search(intent.sourceQuery);
      intent.sourceQuery = undefined;
    }
  }, []);

  const sorted = [...sources].sort((a, b) => a.title.localeCompare(b.title));

  return (
    <div className="view">
      <div className="back-bar">
        <button className="btn-back" onClick={() => navigate("library")}><Icon name="left" size={22} /> Library</button>
      </div>
      <header className="large-title" style={{ paddingTop: 4 }}>
        <div>
          <h1>News sources</h1>
          <p className="subtitle">{sources.length ? `Following ${sources.length}` : "Bluesky accounts, RSS feeds, and Hacker News"}</p>
        </div>
      </header>

      <div className="narrow">
        <form className="page" onSubmit={(e: FormEvent) => (e.preventDefault(), search(query))} style={{ marginTop: 10 }}>
          <label className="field">
            <Icon name="search" size={20} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Bluesky @handle, website, RSS URL, or “HN”"
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
            />
            {busy && <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2, borderColor: "var(--line)", borderTopColor: "var(--text-2)" }} />}
          </label>
        </form>
        <p className="group-note" style={{ margin: "8px 28px 0", color: "var(--text-2)", fontSize: 13 }}>
          Paste any blog, Substack, Mastodon @user@server, RSS link, or search Bluesky — zero API keys needed.
        </p>

        {hits && (
          <>
            <div className="section-head"><h2>Results</h2></div>
            {hits.length ? (
              <div className="group">
                {hits.map((hit) => (
                  <div key={hit.id} className="row with-avatar static">
                    <NewsAvatar id={hit.id} title={hit.title} src={hit.avatar} size={44} />
                    <span className="label">
                      {hit.title}
                      <small>{[hit.handle, hit.about].filter(Boolean).join(" · ")}</small>
                    </span>
                    {have.has(hit.id) ? (
                      <span className="value">Following</span>
                    ) : (
                      <button
                        className="btn accent"
                        onClick={() => add([{ id: hit.id, kind: hit.kind, title: hit.title, handle: hit.handle, siteUrl: hit.siteUrl, avatar: hit.avatar }])}
                      >
                        Follow
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty">No sources found. Try a Bluesky @handle, a website domain, or a direct RSS/Atom URL.</p>
            )}
          </>
        )}

        {sources.length > 0 && (
          <>
            <div className="section-head"><h2>Following</h2></div>
            <div className="group">
              {sorted.map((src) => {
                const newest = feeds[src.id]?.items[0]?.published;
                return (
                  <div key={src.id} className="row with-avatar static">
                    <NewsAvatar id={src.id} title={src.title} src={src.avatar} size={44} />
                    <span className="label">
                      {src.title}
                      <small>
                        {KIND_LABEL[src.kind]}
                        {newest ? ` · Latest ${ago(newest).toLowerCase()}` : " · Loading…"}
                      </small>
                    </span>
                    <button
                      className="icon-btn"
                      aria-label={`Options for ${src.title}`}
                      onClick={() =>
                        showActions({
                          title: src.title,
                          subtitle: src.handle ?? src.siteUrl,
                          actions: [
                            ...(src.siteUrl
                              ? [{ icon: "external" as const, label: "Open website", run: () => openExternalUrl(src.siteUrl!) }]
                              : []),
                            {
                              icon: "unfollow",
                              label: "Unfollow",
                              danger: true,
                              run: () => {
                                removeNewsSource(src.id);
                                toast(`Unfollowed ${src.title}`, {
                                  label: "Undo",
                                  run: () => {
                                    addNewsSources([src]);
                                    refreshNews();
                                  },
                                });
                              },
                            },
                          ],
                        })
                      }
                    >
                      <Icon name="more" size={20} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="section-head"><h2>Starter packs</h2></div>
        <div className="page">
          {NEWS_STARTER_PACKS.map((pack) => {
            const missing = pack.sources.filter((s) => !have.has(s.id));
            return (
              <div key={pack.name} className="pack">
                <span className="name">{pack.name}</span>
                {missing.length ? (
                  <button className="btn accent" onClick={() => add(missing)}>Follow {missing.length}</button>
                ) : (
                  <span className="value" style={{ color: "var(--text-2)" }}>Following</span>
                )}
                <span className="about">{pack.about}</span>
                <span className="pack-meta">{pack.sources.map((s) => s.title).join(" · ")}</span>
              </div>
            );
          })}
        </div>

        <div className="section-head"><h2>Import OPML</h2></div>
        <p className="group-note" style={{ margin: "0 16px 12px", color: "var(--text-2)", fontSize: 14 }}>
          Export an <b>.opml</b> file from Feedly, NetNewsWire, Inoreader, or Reeder and bring all your RSS feeds here in one tap.
        </p>
        <div className="page">
          <button className="btn" onClick={() => opmlInput.current?.click()}>
            <Icon name="download" size={18} /> Choose OPML file
          </button>
        </div>
        <input
          ref={opmlInput}
          type="file"
          accept=".opml,.xml,text/xml,application/xml"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const found = parseOpml(await file.text());
            if (found.length) add(found);
            else toast("No RSS feeds found in that OPML file");
          }}
        />
      </div>
    </div>
  );
}
