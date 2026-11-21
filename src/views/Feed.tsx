import { useEffect, useMemo, useRef, useState } from "react";
import { refreshFeeds, useFeedStatus } from "../lib/feed";
import { navigate } from "../lib/nav";
import { play, usePlayer, warm } from "../lib/player";
import { useStore } from "../lib/store";
import type { Video } from "../lib/types";
import { toVideo, useFeed } from "../lib/useFeed";
import { openVideoActions } from "./actions";
import { Search } from "./Search";
import { Avatar, Frame, Icon, ago, span } from "./ui";

type Length = "all" | "short" | "mid" | "long";
const LENGTHS: [Length, string, (s: number) => boolean][] = [
  ["all", "All", () => true],
  ["short", "Under 1 hr", (s) => s < 3600],
  ["mid", "1–2 hr", (s) => s >= 3600 && s < 7200],
  ["long", "2 hr+", (s) => s >= 7200],
];
const NEW_FOR = 3 * 86_400_000;

export function Feed() {
  const channels = useStore((s) => s.channels);
  const feeds = useStore((s) => s.feeds);
  const mode = useStore((s) => s.settings.mode);
  const frames = useStore((s) => s.settings.frames);
  const latest = useStore((s) => s.history[s.history.length - 1]);
  const { shown, hidden, continuing, progress } = useFeed();
  const status = useFeedStatus();
  const nowPlaying = usePlayer((p) => p.video?.id ?? null);
  const [channel, setChannel] = useState<string | null>(null);
  const [length, setLength] = useState<Length>("all");
  const [searching, setSearching] = useState(false);
  const topbarHidden = useHideOnScroll();
  const pull = usePullToRefresh(() => refreshFeeds(true));

  // Channels ordered by their newest upload; a quiet dot marks unplayed uploads from the last three days.
  const rail = useMemo(() => {
    const newest = (id: string) => Date.parse(feeds[id]?.videos[0]?.published ?? "") || 0;
    const fresh = new Set(shown.filter((v) => Date.now() - Date.parse(v.published) < NEW_FOR && !progress[v.id]).map((v) => v.channelId));
    return [...channels].sort((a, b) => newest(b.id) - newest(a.id)).map((c) => ({ ...c, fresh: fresh.has(c.id) }));
  }, [channels, feeds, shown, progress]);

  const test = LENGTHS.find(([key]) => key === length)![2];
  const showContinue = continuing.length >= 2 && channel === null && length === "all";
  const inCarousel = new Set(showContinue ? continuing.map((p) => p.video.id) : []);
  const list = shown.filter(
    (v) => !inCarousel.has(v.id) && (!channel || v.channelId === channel) && (length === "all" || (v.seconds !== null && test(v.seconds))),
  );
  // Only offer lengths that have something in them (your rules may already rule some out).
  const lengths = LENGTHS.filter(([key, , fits]) => key === "all" || key === length || shown.some((v) => v.seconds !== null && fits(v.seconds)));

  // Look up audio for the most likely next plays, so pressing play is instant.
  const likely = [continuing[0]?.video.id, list[0]?.id].filter(Boolean).join();
  useEffect(() => {
    if (mode !== "listen") return;
    const timer = setTimeout(() => likely.split(",").filter(Boolean).forEach(warm), 1500);
    return () => clearTimeout(timer);
  }, [likely, mode]);

  const loading = status.pending > 0 && !shown.length && !hidden.length;
  const filtered = channel !== null || length !== "all";

  return (
    <div className="view">
      <header className={`topbar${topbarHidden ? " hidden" : ""}`}>
        <a className="brand" href="#" onClick={(e) => (e.preventDefault(), window.scrollTo({ top: 0, behavior: "smooth" }))}>
          <img className="brand-mark" src="/icons/icon-192.png" alt="" />
          <span className="brand-word">Longform</span>
        </a>
        <button className="search-box" onClick={() => setSearching(true)}>
          <Icon name="search" size={18} /> Search your videos and channels
        </button>
        <button className="rule-pill press" onClick={() => navigate("algorithm")} aria-label={`Algorithm version ${latest.v}, ${hidden.length} videos hidden`}>
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

      <div className={`rail-row${channel ? " filtering" : ""}`} role="toolbar" aria-label="Filter by channel">
        {rail.map((c) => (
          <button key={c.id} className={`rail-item press${channel === c.id ? " on" : ""}`} onClick={() => setChannel(channel === c.id ? null : c.id)} aria-pressed={channel === c.id}>
            <span className="pic">
              <Avatar id={c.id} title={c.title} size={56} />
              {c.fresh && <span className="new" aria-label="New episodes" />}
            </span>
            <span className="name">{c.title.replace(/^the\s+/i, "")}</span>
          </button>
        ))}
      </div>

      <div className="chips" role="toolbar" aria-label="Filter by length">
        {lengths.map(([key, label]) => (
          <button key={key} className={`chip press${length === key ? " on" : ""}`} onClick={() => setLength(key)} aria-pressed={length === key}>
            {label}
          </button>
        ))}
      </div>

      {showContinue && (
        <section>
          <div className="section-head"><h2>Continue listening</h2></div>
          <div className="carousel">
            {continuing.map((p) => (
              <button key={p.video.id} className="mini-card press" onClick={() => play(toVideo(p))}>
                <div className="media">
                  <Frame id={p.video.id} size="small" />
                  <div className="progress"><span style={{ width: `${(p.t / p.d) * 100}%` }} /></div>
                </div>
                <div>
                  <div className="t">{p.video.title}</div>
                  <div className="s">{span(p.d - p.t)} left</div>
                </div>
              </button>
            ))}
          </div>
          <div className="section-head"><h2>Latest</h2></div>
        </section>
      )}

      {loading ? (
        <Skeletons />
      ) : list.length ? (
        <ul className="feed-list">
          {list.map((video) => (
            <li key={video.id}>
              <Card video={video} progress={progress[video.id]} now={nowPlaying === video.id} frames={frames} />
            </li>
          ))}
        </ul>
      ) : filtered ? (
        <div className="empty">
          <h3>Nothing here right now</h3>
          <p>No videos match this channel and length.</p>
          <button className="btn" onClick={() => (setChannel(null), setLength("all"))}>Show everything</button>
        </div>
      ) : null}

      {!loading && (
        <footer className="caught-up">
          <span className="check"><Icon name="check" strong /></span>
          <h3>You’re all caught up</h3>
          <p>
            {hidden.length ? (
              <button className="link" onClick={() => navigate("algorithm")}>{hidden.length} hidden by algorithm v{latest.v}</button>
            ) : (
              `Everything from your ${channels.length} channels is here.`
            )}
          </p>
          <p>
            {status.pending > 0 ? `Updating ${status.pending} channels…` : <UpdatedAt feeds={feeds} />}
          </p>
          {status.failed.length > 0 && <p>Couldn’t reach {status.failed.join(", ")}. Pull down to try again.</p>}
        </footer>
      )}

      {searching && <Search onClose={() => setSearching(false)} />}
    </div>
  );
}

function Card({ video, progress, now, frames }: { video: Video; progress?: { t: number; d: number; done?: boolean }; now: boolean; frames: boolean }) {
  const fraction = progress && !progress.done ? progress.t / progress.d : 0;
  const left = fraction > 0.01 ? `${span(progress!.d - progress!.t)} left` : null;
  return (
    <article className={`card${progress?.done ? " played" : ""}${now ? " now" : ""}${frames ? "" : " text-only"}`}>
      {frames && <button className="press" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => play(video)} aria-label={`Play ${video.title}`}>
        <div className="media">
          <Frame id={video.id} />
          <div className="shade" />
          {progress?.done ? (
            <span className="badge done"><Icon name="check" size={13} strong /> Played</span>
          ) : video.seconds ? (
            <span className="badge">{clockLong(video.seconds)}</span>
          ) : null}
          {fraction > 0 && <div className="progress"><span style={{ width: `${fraction * 100}%` }} /></div>}
        </div>
      </button>}
      <div className="meta-row">
        <Avatar id={video.channelId} title={video.channel} size={36} />
        <button className="text" style={{ textAlign: "left" }} onClick={() => play(video)} tabIndex={-1}>
          <span className="title">{video.title}</span>
          <div className="sub">
            {now && <span className="playing">Playing · </span>}
            {video.channel} · {ago(video.published)}
            {!frames && video.seconds ? ` · ${span(video.seconds)}` : ""}
            {left && <> · <span className="left">{left}</span></>}
          </div>
        </button>
        <button className="icon-btn more" onClick={() => openVideoActions(video)} aria-label="More actions">
          <Icon name="more" size={20} />
        </button>
      </div>
    </article>
  );
}

function clockLong(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function UpdatedAt({ feeds }: { feeds: Record<string, { fetchedAt: number }> }) {
  const times = Object.values(feeds).map((f) => f.fetchedAt);
  if (!times.length) return null;
  return (
    <>
      Updated {ago(new Date(Math.min(...times)).toISOString()).toLowerCase()} ·{" "}
      <button className="link" onClick={() => refreshFeeds(true)}>Refresh</button>
    </>
  );
}

function Skeletons() {
  return (
    <ul className="feed-list skeleton" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <li key={i} className="card">
          <div className="media shimmer" />
          <div className="meta-row">
            <span className="avatar shimmer" style={{ width: 36, height: 36 }} />
            <div className="text">
              <div className="line shimmer" />
              <div className="line short shimmer" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Slide the top bar away while scrolling down, bring it back on the way up. */
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

/** Pull down from the very top to refresh, like a native feed. */
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
