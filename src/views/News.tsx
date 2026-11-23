import { useEffect, useMemo, useRef, useState } from "react";
import type { EventCluster } from "../lib/brief";
import { contains } from "../lib/filter";
import { navigate } from "../lib/nav";
import { refreshNews, useNewsStatus } from "../lib/newsFeed";
import { NEWS_STARTER_PACKS } from "../lib/newsStarter";
import { addNewsSources, markNewsRead, markNewsUnread, removeNewsSource, useStore } from "../lib/store";
import type { NewsItem, NewsSource } from "../lib/types";
import { useNews } from "../lib/useNews";
import { Icon, NewsAvatar, Sheet, ago, showActions, toast } from "./ui";

type Mode = "brief" | "events" | "stream";
const MODES: [Mode, string][] = [
  ["brief", "Daily brief"],
  ["events", "Key events"],
  ["stream", "All posts"],
];
const FRESH_FOR = 12 * 3_600_000;

export function News() {
  const sources = useStore((s) => s.newsSources);
  const feeds = useStore((s) => s.newsFeeds);
  const latest = useStore((s) => s.newsHistory[s.newsHistory.length - 1]);
  const { all, shown, hidden, brief, readIds } = useNews();
  const status = useNewsStatus();

  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("brief");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [reading, setReading] = useState<NewsItem | null>(null);
  const [searching, setSearching] = useState(false);
  const topbarHidden = useHideOnScroll();
  const pull = usePullToRefresh(() => refreshNews(true));

  const rail = useMemo(() => {
    const newest = (id: string) => Date.parse(feeds[id]?.items[0]?.published ?? "") || 0;
    const fresh = new Set(
      shown.filter((item) => Date.now() - Date.parse(item.published) < FRESH_FOR && !readIds.has(item.id)).map((item) => item.sourceId),
    );
    return [...sources].sort((a, b) => newest(b.id) - newest(a.id)).map((s) => ({ ...s, fresh: fresh.has(s.id) }));
  }, [sources, feeds, shown, readIds]);

  const activeEvents = useMemo(
    () => (sourceFilter ? brief.events.filter((ev) => ev.sources.some((s) => s.id === sourceFilter)) : brief.events),
    [brief.events, sourceFilter],
  );
  const activeInsights = useMemo(
    () => (sourceFilter ? brief.insights.filter((i) => i.sourceId === sourceFilter) : brief.insights),
    [brief.insights, sourceFilter],
  );
  const activeStream = useMemo(
    () => (sourceFilter ? shown.filter((i) => i.sourceId === sourceFilter) : shown),
    [shown, sourceFilter],
  );

  if (!sources.length) {
    return <NewsOnboarding />;
  }

  const loading = status.pending > 0 && !shown.length && !hidden.length;
  const unreadIds = activeStream.filter((i) => !readIds.has(i.id)).map((i) => i.id);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const markReadWithUndo = (ids: string[], label: string) => {
    markNewsRead(ids);
    toast(label, { label: "Undo", run: () => markNewsUnread(ids) });
  };

  const openItemActions = (item: NewsItem) => {
    const isRead = readIds.has(item.id);
    showActions({
      title: item.title,
      subtitle: `${item.sourceTitle} · ${ago(item.published)}`,
      actions: [
        { icon: "external", label: item.domain ? `Open on ${item.domain}` : "Open original", run: () => window.open(item.url, "_blank", "noopener") },
        ...(item.discussionUrl
          ? [{ icon: "news" as const, label: item.sourceKind === "hn" ? "Open Hacker News thread" : "Open Bluesky post", run: () => window.open(item.discussionUrl, "_blank", "noopener") }]
          : []),
        isRead
          ? { icon: "restore", label: "Mark as unread", run: () => markNewsUnread([item.id]) }
          : { icon: "done", label: "Mark as read", run: () => markReadWithUndo([item.id], "Marked as read") },
        {
          icon: "unfollow",
          label: `Unfollow ${item.sourceTitle}`,
          danger: true,
          run: () => {
            const removed = sources.find((s) => s.id === item.sourceId);
            removeNewsSource(item.sourceId);
            if (removed) {
              toast(`Unfollowed ${removed.title}`, {
                label: "Undo",
                run: () => {
                  addNewsSources([removed]);
                  refreshNews();
                },
              });
            }
          },
        },
      ],
    });
  };

  const showEvents = mode === "brief" || mode === "events";
  const showInsights = mode === "brief";
  const showStream = mode === "stream";
  const visibleCount = showStream ? activeStream.length : (showEvents ? activeEvents.length : 0) + (showInsights ? activeInsights.length : 0);

  return (
    <div className="view">
      <header className={`topbar${topbarHidden ? " hidden" : ""}`}>
        <a className="brand" href="#news" onClick={(e) => (e.preventDefault(), window.scrollTo({ top: 0, behavior: "smooth" }))}>
          <img className="brand-mark" src="/icons/icon-192.png" alt="" />
          <span className="brand-word">News</span>
        </a>
        <button className="search-box" onClick={() => setSearching(true)}>
          <Icon name="search" size={18} /> Search today’s brief and sources
        </button>
        <button
          className="rule-pill press"
          onClick={() => navigate("algorithm", { algorithmTab: "news" })}
          aria-label={`News algorithm version ${latest.v}, ${hidden.length} items hidden`}
        >
          <span className="v">v{latest.v}</span>
          <span className="n">{hidden.length} hidden</span>
        </button>
        <button className="icon-btn" onClick={() => setSearching(true)} aria-label="Search">
          <Icon name="search" />
        </button>
      </header>

      <div className={`pull${pull.spinning ? " spinning" : ""}`} style={{ height: pull.height }} aria-hidden="true">
        <span style={{ transform: `rotate(${pull.height * 3}deg)` }}><Icon name="refresh" size={22} /></span>
      </div>

      <div className={`rail-row${sourceFilter ? " filtering" : ""}`} role="toolbar" aria-label="Filter by source">
        {rail.map((s) => (
          <button
            key={s.id}
            className={`rail-item press${sourceFilter === s.id ? " on" : ""}`}
            onClick={() => setSourceFilter(sourceFilter === s.id ? null : s.id)}
            aria-pressed={sourceFilter === s.id}
          >
            <span className="pic">
              <NewsAvatar id={s.id} title={s.title} src={s.avatar} size={56} />
              {s.fresh && <span className="new" aria-label="Unread updates" />}
            </span>
            <span className="name">{s.title.replace(/^the\s+/i, "")}</span>
          </button>
        ))}
        <button className="rail-item press" onClick={() => navigate("library/sources")} aria-label="Manage news sources">
          <span className="pic">
            <span className="avatar add-source-avatar" style={{ width: 56, height: 56 }}>
              <Icon name="plus" size={22} />
            </span>
          </span>
          <span className="name">Sources</span>
        </button>
      </div>

      <div className="chips" role="toolbar" aria-label="News view">
        {MODES.map(([key, label]) => (
          <button key={key} className={`chip press${mode === key ? " on" : ""}`} onClick={() => setMode(key)} aria-pressed={mode === key}>
            {label}
            {key === "events" && activeEvents.length > 0 ? ` · ${activeEvents.length}` : ""}
          </button>
        ))}
        {unreadIds.length > 0 && (
          <button
            className="chip press"
            onClick={() => markReadWithUndo(unreadIds, `Marked ${unreadIds.length} as read`)}
            aria-label="Mark visible items as read"
          >
            Mark all read
          </button>
        )}
      </div>

      <div className="narrow news-body">
        {loading ? (
          <NewsSkeletons />
        ) : (
          <>
            {showEvents && activeEvents.length > 0 && (
              <section aria-label="Key events">
                <div className="section-head">
                  <h2>Key events</h2>
                  <span className="news-count">{activeEvents.length} {activeEvents.length === 1 ? "story" : "stories"}</span>
                </div>
                <div className="event-list">
                  {activeEvents.map((ev) => (
                    <EventCard
                      key={ev.id}
                      cluster={ev}
                      expanded={expanded.has(ev.id)}
                      onToggle={() => toggleExpand(ev.id)}
                      onReadItem={(item) => setReading(item)}
                      onMarkDone={() => markReadWithUndo(ev.items.map((i) => i.id), "Story marked read")}
                    />
                  ))}
                </div>
              </section>
            )}

            {showEvents && mode === "events" && !activeEvents.length && (
              <div className="empty">
                <h3>No multi-source events right now</h3>
                <p>When two or more of your sources cover the same developing story, it gathers here automatically.</p>
                <button className="btn" onClick={() => setMode("brief")}>Show daily brief</button>
              </div>
            )}

            {showInsights && activeInsights.length > 0 && (
              <section aria-label="Key insights">
                <div className="section-head">
                  <h2>{activeEvents.length ? "Key insights" : "Today’s brief"}</h2>
                  <span className="news-count">{activeInsights.length}</span>
                </div>
                <ul className="news-list">
                  {activeInsights.map((item) => (
                    <li key={item.id}>
                      <NewsRow
                        item={item}
                        isRead={readIds.has(item.id)}
                        onOpen={() => setReading(item)}
                        onMore={() => openItemActions(item)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {showStream && activeStream.length > 0 && (
              <section aria-label="All posts">
                <div className="section-head">
                  <h2>Latest</h2>
                  <span className="news-count">{activeStream.length}</span>
                </div>
                <ul className="news-list">
                  {activeStream.map((item) => (
                    <li key={item.id}>
                      <NewsRow
                        item={item}
                        isRead={readIds.has(item.id)}
                        onOpen={() => setReading(item)}
                        onMore={() => openItemActions(item)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {sourceFilter && !visibleCount && (
              <div className="empty">
                <h3>Nothing new from this source</h3>
                <p>Everything here is either read or outside your current news window.</p>
                <button className="btn" onClick={() => setSourceFilter(null)}>Show all sources</button>
              </div>
            )}
          </>
        )}

        {!loading && (
          <footer className="caught-up">
            <span className="check"><Icon name="check" strong /></span>
            <h3>You’re all caught up</h3>
            <p>
              {hidden.length ? (
                <button className="link" onClick={() => navigate("algorithm", { algorithmTab: "news" })}>
                  {hidden.length} hidden by news algorithm v{latest.v}
                </button>
              ) : (
                `Everything from your ${sources.length} sources is here.`
              )}
            </p>
            <p>
              {status.pending > 0 ? `Updating ${status.pending} sources…` : <UpdatedAt feeds={feeds} />}
            </p>
            {status.failed.length > 0 && <p>Couldn’t reach {status.failed.slice(0, 3).join(", ")}. Pull down to try again.</p>}
          </footer>
        )}
      </div>

      {reading && (
        <ReaderSheet
          item={reading}
          isRead={readIds.has(reading.id)}
          onClose={() => setReading(null)}
          onToggleRead={() => {
            if (readIds.has(reading.id)) markNewsUnread([reading.id]);
            else markNewsRead([reading.id]);
          }}
        />
      )}

      {searching && (
        <NewsSearchSheet
          all={all}
          hidden={hidden}
          sources={sources}
          onClose={() => setSearching(false)}
          onOpen={(item) => (setSearching(false), setReading(item))}
        />
      )}
    </div>
  );
}

function EventCard({
  cluster,
  expanded,
  onToggle,
  onReadItem,
  onMarkDone,
}: {
  cluster: EventCluster;
  expanded: boolean;
  onToggle: () => void;
  onReadItem: (item: NewsItem) => void;
  onMarkDone: () => void;
}) {
  const lead = cluster.items[0];
  return (
    <article className="event-card">
      <div className="event-top">
        <div className="event-sources">
          <span className="event-badge">{cluster.sources.length} sources</span>
          <span className="event-names">{cluster.sources.map((s) => s.title).join(" · ")}</span>
        </div>
        <span className="event-time">{ago(cluster.latestAt)}</span>
      </div>

      <button className="event-headline" onClick={() => onReadItem(lead)}>
        {cluster.headline}
      </button>

      {cluster.summary && <p className="event-summary">{cluster.summary}</p>}

      {cluster.takeaways.length > 0 && (
        <ul className="event-takeaways">
          {cluster.takeaways.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <div className="event-foot">
        <button className="event-toggle" onClick={onToggle} aria-expanded={expanded}>
          <span>{expanded ? "Hide coverage" : `Read ${cluster.items.length} posts`}</span>
          <Icon name="down" size={16} />
        </button>
        <button className="event-done press" onClick={onMarkDone} aria-label="Mark story as read">
          <Icon name="check" size={16} strong />
          <span>Done</span>
        </button>
      </div>

      {expanded && (
        <ul className="event-drawer">
          {cluster.items.map((item) => (
            <li key={item.id}>
              <button className="event-source-row" onClick={() => onReadItem(item)}>
                <NewsAvatar id={item.sourceId} title={item.sourceTitle} size={24} />
                <span className="event-source-text">
                  <b>{item.sourceTitle}</b>
                  <span>{item.title}</span>
                </span>
                <span className="event-source-time">{ago(item.published)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function NewsRow({
  item,
  isRead,
  onOpen,
  onMore,
}: {
  item: NewsItem;
  isRead: boolean;
  onOpen: () => void;
  onMore: () => void;
}) {
  const showExcerpt = item.text && item.text.toLowerCase() !== item.title.toLowerCase() && !item.text.toLowerCase().startsWith(item.title.toLowerCase().slice(0, 40));
  return (
    <article className={`news-item${isRead ? " is-read" : ""}`}>
      <NewsAvatar id={item.sourceId} title={item.sourceTitle} size={34} />
      <button className="news-item-main" onClick={onOpen}>
        <div className="news-meta">
          <b>{item.sourceTitle}</b>
          {item.domain && <span> · {item.domain}</span>}
          <span> · {ago(item.published)}</span>
        </div>
        <div className="news-title">{item.title}</div>
        {showExcerpt && <p className="news-excerpt">{item.text}</p>}
        {item.quotedText && (
          <div className="news-quote">
            {item.quotedAuthor && <b>{item.quotedAuthor}: </b>}
            {item.quotedText}
          </div>
        )}
      </button>
      <button className="icon-btn more" onClick={onMore} aria-label="More actions">
        <Icon name="more" size={20} />
      </button>
    </article>
  );
}

function ReaderSheet({
  item,
  isRead,
  onClose,
  onToggleRead,
}: {
  item: NewsItem;
  isRead: boolean;
  onClose: () => void;
  onToggleRead: () => void;
}) {
  const sameBody = !item.text || item.text.toLowerCase() === item.title.toLowerCase();
  return (
    <Sheet onClose={onClose} label={item.title}>
      <div className="reader-body">
        <div className="reader-source">
          <NewsAvatar id={item.sourceId} title={item.sourceTitle} size={36} />
          <div>
            <div className="reader-author">{item.sourceTitle}</div>
            <div className="reader-sub">
              {[item.handle, item.domain, new Date(item.published).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>

        <h2 className="reader-title">{item.title}</h2>
        {!sameBody && <p className="reader-text">{item.text}</p>}

        {item.quotedText && (
          <blockquote className="reader-quote">
            {item.quotedAuthor && <div className="reader-quote-by">{item.quotedAuthor}</div>}
            <p>{item.quotedText}</p>
          </blockquote>
        )}

        <div className="reader-actions">
          <a className="btn accent" href={item.url} target="_blank" rel="noopener noreferrer" onClick={() => !isRead && markNewsRead([item.id])}>
            <Icon name="external" size={16} />
            {item.domain ? `Read on ${item.domain}` : "Open original"}
          </a>
          {item.discussionUrl && (
            <a className="btn" href={item.discussionUrl} target="_blank" rel="noopener noreferrer">
              {item.sourceKind === "hn" ? "HN thread" : "Original post"}
            </a>
          )}
          <button
            className="btn"
            onClick={() => {
              onToggleRead();
              onClose();
            }}
          >
            <Icon name={isRead ? "restore" : "done"} size={16} />
            {isRead ? "Mark unread" : "Mark read"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function NewsSearchSheet({
  all,
  hidden,
  sources,
  onClose,
  onOpen,
}: {
  all: NewsItem[];
  hidden: { item: NewsItem; reason: string }[];
  sources: NewsSource[];
  onClose: () => void;
  onOpen: (item: NewsItem) => void;
}) {
  const [query, setQuery] = useState("");
  const hiddenWhy = useMemo(() => new Map(hidden.map((h) => [h.item.id, h.reason])), [hidden]);
  const q = query.trim();

  const matches = useMemo(() => {
    if (!q) return [];
    const words = q.split(/\s+/);
    const seen = new Set<string>();
    return all
      .filter((i) => words.every((w) => contains(`${i.title} ${i.text} ${i.sourceTitle}`, `${w}*`)) && !seen.has(i.id) && seen.add(i.id))
      .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
      .slice(0, 40);
  }, [all, q]);
  const matchingSources = q ? sources.filter((s) => contains(`${s.title} ${s.handle ?? ""}`, `${q}*`)) : [];

  return (
    <Sheet onClose={onClose} label="Search news" full>
      <div className="search-head">
        <label className="field">
          <Icon name="search" size={20} />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your brief, posts, and sources"
            enterKeyHint="search"
            autoCorrect="off"
          />
        </label>
        <button className="cancel" onClick={onClose}>Cancel</button>
      </div>

      {matchingSources.length > 0 && (
        <>
          <div className="search-section">Sources</div>
          {matchingSources.map((s) => (
            <div key={s.id} className="row with-avatar static">
              <NewsAvatar id={s.id} title={s.title} src={s.avatar} size={40} />
              <span className="label">{s.title}{s.handle && <small>{s.handle}</small>}</span>
            </div>
          ))}
        </>
      )}

      {matches.length > 0 && <div className="search-section">Posts & articles</div>}
      {matches.map((item) => (
        <button key={item.id} className="compact news-compact" onClick={() => onOpen(item)}>
          <NewsAvatar id={item.sourceId} title={item.sourceTitle} size={34} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="t">{item.title}</div>
            <div className="s">{item.sourceTitle} · {ago(item.published)}</div>
            {hiddenWhy.has(item.id) && <span className="why"><Icon name="eyeOff" size={13} /> {hiddenWhy.get(item.id)}</span>}
          </div>
        </button>
      ))}

      {q && (
        <button className="row with-icon" onClick={() => (onClose(), navigate("library/sources", { sourceQuery: q }))}>
          <span className="lead"><Icon name="plus" /></span>
          <span className="label">Find “{q}” on Bluesky or RSS<small>Follow a new news source</small></span>
          <span className="chev"><Icon name="right" size={18} /></span>
        </button>
      )}
      {q && !matches.length && !matchingSources.length && <p className="empty">Nothing in your brief matches “{q}”.</p>}
    </Sheet>
  );
}

function NewsOnboarding() {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(["World & Markets", "AI & Engineering"]));
  const chosen = NEWS_STARTER_PACKS.filter((p) => picked.has(p.name));
  const count = new Set(chosen.flatMap((p) => p.sources.map((s) => s.id))).size;

  const toggle = (name: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="view">
      <div className="onboarding news-onboarding">
        <h1>Your daily brief, without the scroll trap.</h1>
        <p className="lede">
          Zero API keys. Public Bluesky accounts, RSS feeds, and Hacker News — grouped into key events as they happen and filtered by rules you control.
        </p>

        {NEWS_STARTER_PACKS.map((pack) => (
          <button
            key={pack.name}
            className={`pack press${picked.has(pack.name) ? " selected" : ""}`}
            onClick={() => toggle(pack.name)}
            aria-pressed={picked.has(pack.name)}
          >
            <span className="name">{pack.name}</span>
            <span className="tick"><Icon name="check" size={16} strong /></span>
            <span className="about">{pack.about}</span>
            <span className="pack-meta">{pack.sources.map((s) => s.title).slice(0, 5).join(" · ")}{pack.sources.length > 5 ? ` +${pack.sources.length - 5}` : ""}</span>
          </button>
        ))}

        <div className="news-onboard-cta">
          <button
            className="btn accent big press"
            disabled={!count}
            onClick={() => {
              addNewsSources(chosen.flatMap((p) => p.sources));
              refreshNews();
            }}
          >
            {count ? `Build my brief from ${count} sources` : "Pick at least one"}
          </button>
          <button className="secondary" onClick={() => navigate("library/sources")}>
            Add my own Bluesky handles, RSS feeds, or OPML
          </button>
        </div>
      </div>
    </div>
  );
}

function UpdatedAt({ feeds }: { feeds: Record<string, { fetchedAt: number }> }) {
  const times = Object.values(feeds).map((f) => f.fetchedAt);
  if (!times.length) return null;
  return (
    <>
      Updated {ago(new Date(Math.min(...times)).toISOString()).toLowerCase()} ·{" "}
      <button className="link" onClick={() => refreshNews(true)}>Refresh</button>
    </>
  );
}

function NewsSkeletons() {
  return (
    <div className="event-list skeleton" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="event-card">
          <div className="line short shimmer" />
          <div className="line shimmer" />
          <div className="line shimmer" style={{ width: "74%" }} />
        </div>
      ))}
    </div>
  );
}

function useHideOnScroll(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = Math.max(0, window.scrollY);
      const delta = y - last;
      if (y < 44) setHidden(false);
      else if (delta > 8) setHidden(true);
      else if (delta < -8) setHidden(false);
      if (Math.abs(delta) > 8) last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return hidden;
}

function usePullToRefresh(refresh: () => Promise<void>): { height: number; spinning: boolean } {
  const [height, setHeight] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const start = useRef<number | null>(null);
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      start.current = window.scrollY <= 0 && !document.documentElement.classList.contains("sheet-open") ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = e.touches[0].clientY - start.current;
      setHeight(dy > 0 ? Math.min(72, dy * 0.45) : 0);
    };
    const onEnd = () => {
      if (start.current === null) return;
      start.current = null;
      setHeight((h) => {
        if (h >= 56) {
          setSpinning(true);
          latest.current().finally(() => {
            setSpinning(false);
            setHeight(0);
          });
          return 48;
        }
        return 0;
      });
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, []);
  return { height, spinning };
}
