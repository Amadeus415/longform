import { useEffect, useMemo, useRef, useState } from "react";
import { refreshDiscover, useDiscoverStatus } from "../lib/discover";
import { refreshFeeds, useFeedStatus } from "../lib/feed";
import { navigate } from "../lib/nav";
import { play, usePlayer, warm } from "../lib/player";
import { dayKey, useStore } from "../lib/store";
import type { LlmJudgment, PersonalScore, Video, VideoRating } from "../lib/types";
import { toVideo, useFeed } from "../lib/useFeed";
import { openVideoActions } from "./actions";
import { openRatingSheet, scoreTone } from "./Rating";
import { Search } from "./Search";
import { Avatar, Frame, Icon, Segmented, ago, span } from "./ui";

type SourceTab = "all" | "following" | "discover";
type Length = "all" | "concise" | "short" | "mid" | "long";
const LENGTHS: [Length, string, (s: number) => boolean][] = [
  ["all", "All lengths", () => true],
  ["concise", "Under 20m", (s) => s < 1200],
  ["short", "20–60m", (s) => s >= 1200 && s < 3600],
  ["mid", "1–2 hr", (s) => s >= 3600 && s < 7200],
  ["long", "2 hr+", (s) => s >= 7200],
];
const NEW_FOR = 3 * 86_400_000;

export function Feed() {
  const channels = useStore((s) => s.channels);
  const feeds = useStore((s) => s.feeds);
  const mode = useStore((s) => s.settings.mode);
  const frames = useStore((s) => s.settings.frames);
  const ratings = useStore((s) => s.ratings);
  const listenedToday = useStore((s) => s.listened[dayKey()] ?? 0);
  const latest = useStore((s) => s.history[s.history.length - 1]);
  const {
    shown,
    shownFollowing,
    shownFollowingAll,
    shownDiscover,
    hidden,
    pending,
    continuing,
    progress,
    rules,
    discover,
    judgments,
    personalScores,
  } = useFeed();
  const status = useFeedStatus();
  const discoverStatus = useDiscoverStatus();
  const nowPlaying = usePlayer((p) => p.video?.id ?? null);
  const [sourceTab, setSourceTab] = useState<SourceTab>("all");
  const [channel, setChannel] = useState<string | null>(null);
  const [length, setLength] = useState<Length>("all");
  const [searching, setSearching] = useState(false);
  const [budgetDismissed, setBudgetDismissed] = useState(false);
  const topbarHidden = useHideOnScroll();

  // Pull-to-refresh updates followed channels only (anti-slot-machine: Discover is a calm daily edition).
  const refreshFollowing = () => refreshFeeds(true);
  const pull = usePullToRefresh(refreshFollowing);

  const budgetReached =
    !budgetDismissed && rules.dailyBudgetMinutes > 0 && listenedToday >= rules.dailyBudgetMinutes * 60;

  // If recommendations are turned off while viewing Discover, return to All.
  useEffect(() => {
    if (!rules.discoverEnabled && sourceTab !== "all") setSourceTab("all");
  }, [rules.discoverEnabled, sourceTab]);

  // Channels ordered by their newest upload; a quiet dot marks unplayed uploads from the last three days.
  const rail = useMemo(() => {
    const newest = (id: string) => Date.parse(feeds[id]?.videos[0]?.published ?? "") || 0;
    const fresh = new Set(
      shownFollowingAll.filter((v) => Date.now() - Date.parse(v.published) < NEW_FOR && !progress[v.id]).map((v) => v.channelId),
    );
    return [...channels].sort((a, b) => newest(b.id) - newest(a.id)).map((c) => ({ ...c, fresh: fresh.has(c.id) }));
  }, [channels, feeds, shownFollowingAll, progress]);

  const baseList = useMemo(() => {
    if (channel) return shownFollowingAll;
    if (sourceTab === "following") return shownFollowing;
    if (sourceTab === "discover") return shownDiscover;
    return shown;
  }, [channel, sourceTab, shown, shownFollowing, shownFollowingAll, shownDiscover]);

  const test = LENGTHS.find(([key]) => key === length)![2];
  const showContinue = continuing.length >= 2 && channel === null && length === "all" && sourceTab !== "discover";
  const inCarousel = new Set(showContinue ? continuing.map((p) => p.video.id) : []);
  const list = baseList.filter(
    (v) => !inCarousel.has(v.id) && (!channel || v.channelId === channel) && (length === "all" || (v.seconds !== null && test(v.seconds))),
  );
  // Only offer lengths that have something in them (your rules may already rule some out).
  const lengths = LENGTHS.filter(([key, , fits]) => key === "all" || key === length || baseList.some((v) => v.seconds !== null && fits(v.seconds)));

  // Look up audio for the most likely next plays, so pressing play is instant.
  const likely = [continuing[0]?.video.id, list[0]?.id].filter(Boolean).join();
  useEffect(() => {
    if (mode !== "listen") return;
    const timer = setTimeout(() => likely.split(",").filter(Boolean).forEach(warm), 1500);
    return () => clearTimeout(timer);
  }, [likely, mode]);

  const loading = (status.pending > 0 && !shown.length && !hidden.length) || (sourceTab === "discover" && discoverStatus.loading && !shownDiscover.length);
  const filtered = channel !== null || length !== "all";
  const today = dayKey();
  const discoverEditionDay = discover?.editionDay ?? (discover?.fetchedAt ? dayKey(new Date(discover.fetchedAt)) : null);
  const discoverEditionDone = Boolean(
    discover && discoverEditionDay === today && discover.videos.length > 0 && pending.length === 0 && shownDiscover.length === 0,
  );

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
          <span className="n">{discoverStatus.judging ? "Judging…" : `${hidden.length} hidden`}</span>
        </button>
        <button className="icon-btn" onClick={() => setSearching(true)} aria-label="Search">
          <Icon name="search" />
        </button>
      </header>

      <div className={`pull${pull.spinning ? " spinning" : ""}`} style={{ height: pull.height }} aria-hidden="true">
        <span style={{ transform: `rotate(${pull.height * 3}deg)` }}><Icon name="refresh" size={22} /></span>
      </div>

      {sourceTab !== "discover" && (
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
      )}

      {rules.discoverEnabled && (
        <div className="feed-source-bar">
          <Segmented
            value={sourceTab}
            options={[
              ["all", "All"],
              ["following", "Following"],
              ["discover", shownDiscover.length ? `Discover (${shownDiscover.length})` : "Discover"],
            ]}
            onChange={(next) => {
              setSourceTab(next);
              if (next === "discover") {
                setChannel(null);
                if (!discover?.videos.length && !discoverStatus.loading) refreshDiscover(false);
              }
            }}
          />
        </div>
      )}

      {lengths.length > 1 && (
        <div className="chips" role="toolbar" aria-label="Filter by length">
          {lengths.map(([key, label]) => (
            <button key={key} className={`chip press${length === key ? " on" : ""}`} onClick={() => setLength(key)} aria-pressed={length === key}>
              {label}
            </button>
          ))}
        </div>
      )}

      {budgetReached && (
        <div className="discover-banner" role="status">
          <span>
            You’ve reached your {rules.dailyBudgetMinutes}m daily listening goal ({span(listenedToday)} today). Good place to pause.
          </span>
          <button className="link" onClick={() => setBudgetDismissed(true)}>Keep browsing</button>
        </div>
      )}

      {discoverStatus.judgeError && (
        <div className="discover-banner" role="status">
          <span>AI judge: {discoverStatus.judgeError}</span>
          <button className="link" onClick={() => navigate("algorithm")}>Settings</button>
        </div>
      )}

      {sourceTab === "discover" && discover && (
        <div className="discover-banner">
          <span>
            <Icon name="spark" size={14} />{" "}
            Daily edition · {discover.mode === "home" ? "YouTube Home" : "Watch-Next"}
            {rules.llm.enabled && discoverStatus.judgeAvailable ? ` · AI ≥ ${rules.llm.minScore}/10` : ""}
            {pending.length > 0 ? ` · ${discoverStatus.judging ? `Scoring ${pending.length}…` : `${pending.length} waiting for AI`}` : " · Next edition tomorrow"}
          </span>
          <button className="link" onClick={() => navigate("algorithm")}>Tune</button>
        </div>
      )}

      {sourceTab !== "discover" && pending.length > 0 && discoverStatus.judging && (
        <div className="discover-banner" role="status">
          <span>
            <Icon name="spark" size={14} /> Scoring {pending.length} Discover {pending.length === 1 ? "video" : "videos"} before showing…
          </span>
        </div>
      )}

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
              <Card
                video={video}
                progress={progress[video.id]}
                judgment={judgments[video.id]}
                personal={personalScores[video.id]}
                rating={ratings[video.id]}
                now={nowPlaying === video.id}
                frames={frames}
              />
            </li>
          ))}
        </ul>
      ) : filtered ? (
        <div className="empty">
          <h3>Nothing here right now</h3>
          <p>No videos match this channel and length.</p>
          <button className="btn" onClick={() => (setChannel(null), setLength("all"))}>Show everything</button>
        </div>
      ) : sourceTab === "discover" ? (
        <div className="empty">
          <h3>
            {pending.length > 0
              ? "Vetting today’s Discover edition"
              : discoverEditionDone
                ? "You’ve finished today’s Discover edition"
                : "No recommendations yet"}
          </h3>
          <p>
            {discoverStatus.error
              ? discoverStatus.error
              : pending.length > 0 && discoverStatus.judgeAvailable === false
                ? `${pending.length} candidates held back because GEMINI_API_KEY is not set on this server. Set a key, or turn off the AI judge to browse with the clickbait guard.`
                : pending.length > 0
                  ? `Scoring ${pending.length} candidates with Gemini so unvetted videos never flash into your feed.`
                  : discoverEditionDone
                    ? "Your next calm daily edition arrives tomorrow. No endless scroll."
                    : "Pull today’s calm Discover edition seeded from your top-rated and followed channels."}
          </p>
          {pending.length > 0 && discoverStatus.judgeAvailable === false ? (
            <button className="btn" onClick={() => navigate("algorithm")}>Open Algorithm</button>
          ) : discoverEditionDone ? (
            <button className="btn" onClick={() => setSourceTab("following")}>Back to Following</button>
          ) : discover && discoverEditionDay === today && discover.videos.length > 0 ? (
            <button className="btn" onClick={() => navigate("algorithm")}>Open Algorithm</button>
          ) : (
            <button className="btn accent" onClick={() => refreshDiscover(false)}>Find recommendations</button>
          )}
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
            {status.pending > 0
              ? `Updating ${status.pending} channels…`
              : discoverStatus.loading
                ? "Finding educational recommendations…"
                : discoverStatus.judging
                  ? `Scoring ${discoverStatus.judgeRemaining || ""} videos with Gemini…`
                  : <UpdatedAt feeds={feeds} onRefresh={refreshFollowing} />}
          </p>
          {status.failed.length > 0 && <p>Couldn’t reach {status.failed.join(", ")}. Pull down to try again.</p>}
        </footer>
      )}

      {searching && <Search onClose={() => setSearching(false)} />}
    </div>
  );
}

function Card({
  video,
  progress,
  judgment,
  personal,
  rating,
  now,
  frames,
}: {
  video: Video;
  progress?: { t: number; d: number; done?: boolean };
  judgment?: LlmJudgment;
  personal?: PersonalScore;
  rating?: VideoRating;
  now: boolean;
  frames: boolean;
}) {
  const fraction = progress && !progress.done ? progress.t / progress.d : 0;
  const left = fraction > 0.01 ? `${span(progress!.d - progress!.t)} left` : null;
  const isDiscover = video.source === "discover";
  return (
    <article className={`card${progress?.done ? " played" : ""}${now ? " now" : ""}${frames ? "" : " text-only"}`}>
      {frames && (
        <button className="press" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => play(video)} aria-label={`Play ${video.title}`}>
          <div className="media">
            <Frame id={video.id} />
            <div className="shade" />
            {isDiscover && (
              <span className="badge discover-badge">
                <Icon name="spark" size={12} /> Discover
              </span>
            )}
            {progress?.done ? (
              <span className="badge done"><Icon name="check" size={13} strong /> Played</span>
            ) : video.seconds ? (
              <span className="badge">{clockLong(video.seconds)}</span>
            ) : null}
            {fraction > 0 && <div className="progress"><span style={{ width: `${fraction * 100}%` }} /></div>}
          </div>
        </button>
      )}
      <div className="meta-row">
        <Avatar id={video.channelId} title={video.channel} size={36} />
        <div className="text">
          <button className="text-trigger" onClick={() => play(video)} tabIndex={-1}>
            <span className="title">{video.title}</span>
            <div className="sub">
              {now && <span className="playing">Playing · </span>}
              {isDiscover && !frames && <span className="discover-inline">Discover · </span>}
              {video.channel} · {ago(video.published)}
              {!frames && video.seconds ? ` · ${span(video.seconds)}` : ""}
              {left && <> · <span className="left">{left}</span></>}
            </div>
          </button>
          <div className="sub-reason">
            <button
              type="button"
              className={`rate-chip press${rating ? ` rated tone-${scoreTone(rating.score)}` : ""}`}
              onClick={() => openRatingSheet(video, judgment)}
              aria-label={rating ? `Rated ${rating.score} out of 10. Edit rating` : `Rate ${video.title} from 1 to 10`}
            >
              <Icon name={rating ? "starFill" : "star"} size={11} />
              {rating ? `${rating.score}/10` : "Rate"}
            </button>
            {judgment && (
              <span className="ai-chip" title={personal?.breakdown.length ? personal.breakdown.join(" · ") : judgment.reason}>
                AI {judgment.score}/10
                {personal && !personal.isDirectRating && Math.abs(personal.delta) >= 0.2
                  ? ` → ${personal.effectiveScore.toFixed(1)}`
                  : ""}
                {judgment.category ? ` · ${judgment.category}` : ""}
              </span>
            )}
            {isDiscover && video.recommendedReason && <span className="rec-why">{video.recommendedReason}</span>}
          </div>
        </div>
        <button className="icon-btn more" onClick={() => openVideoActions(video, judgment)} aria-label="More actions">
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

function UpdatedAt({ feeds, onRefresh }: { feeds: Record<string, { fetchedAt: number }>; onRefresh: () => void }) {
  const times = Object.values(feeds).map((f) => f.fetchedAt);
  if (!times.length) return null;
  return (
    <>
      Updated {ago(new Date(Math.min(...times)).toISOString()).toLowerCase()} ·{" "}
      <button className="link" onClick={onRefresh}>Refresh</button>
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
