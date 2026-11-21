import { useEffect } from "react";
import { refreshFeeds, useFeedStatus } from "../lib/feed";
import { play, usePlayer, warm } from "../lib/player";
import { useStore } from "../lib/store";
import { toVideo, useFeed } from "../lib/useFeed";
import type { Video } from "../lib/types";
import { Frame, ago, minutes } from "./ui";
import { Welcome } from "./Welcome";

export function Feed({ onShowHidden, onChannels }: { onShowHidden: () => void; onChannels: () => void }) {
  const { channels, settings, feeds } = useStore();
  const { shown, hidden, continuing, progress } = useFeed();
  const status = useFeedStatus();
  const nowPlaying = usePlayer((p) => p.video?.id ?? null);

  const continuingIds = new Set(continuing.map((p) => p.video.id));
  const list = shown.filter((v) => !continuingIds.has(v.id));

  // Look up audio for the two most likely next plays, so tapping them starts instantly.
  const likely = [continuing[0]?.video.id, list[0]?.id].filter(Boolean).join();
  useEffect(() => {
    if (settings.mode !== "listen") return;
    const timer = setTimeout(() => likely.split(",").filter(Boolean).forEach(warm), 1500);
    return () => clearTimeout(timer);
  }, [likely, settings.mode]);

  if (!channels.length) return <Welcome onChannels={onChannels} />;

  const loadingFirstTime = status.pending > 0 && !shown.length && !hidden.length;

  const row = (video: Video, done?: number) => {
    const p = progress[video.id];
    const fraction = done ?? (p && !p.done ? p.t / p.d : 0);
    const left = p && !p.done && p.t > 30 ? `${minutes(p.d - p.t)} left` : null;
    return (
      <li key={video.id}>
        <button className={`row${nowPlaying === video.id ? " now" : ""}${p?.done ? " done" : ""}`} onClick={() => play(video)}>
          <div className="row-text">
            <span className="row-title">{video.title}</span>
            <span className="meta row-meta">
              <span className="channel">{video.channel}</span>
              <span>
                {video.published ? `\u00a0· ${ago(video.published)}` : ""}
                {left ? ` · ${left}` : !settings.frames && video.seconds ? ` · ${minutes(video.seconds)}` : ""}
              </span>
            </span>
          </div>
          {settings.frames && <Frame id={video.id} seconds={video.seconds} progress={fraction} />}
        </button>
      </li>
    );
  };

  return (
    <div className="feed">
      {continuing.length > 0 && (
        <section>
          <h2 className="label">Continue</h2>
          <ul className="list">{continuing.map((p) => row(toVideo(p), p.t / p.d))}</ul>
        </section>
      )}

      <section>
        {continuing.length > 0 && <h2 className="label">Latest</h2>}
        {loadingFirstTime ? (
          <p className="quiet center">Loading {channels.length} channels…</p>
        ) : (
          <ul className="list">{list.map((v) => row(v))}</ul>
        )}
      </section>

      {!loadingFirstTime && (
        <footer className="end">
          <p>
            {list.length ? "That’s everything" : "Nothing new"} from your {channels.length} channel{channels.length === 1 ? "" : "s"}.
          </p>
          {hidden.length > 0 && (
            <button className="link" onClick={onShowHidden}>
              {hidden.length} hidden by your rules
            </button>
          )}
          {status.failed.length > 0 && <p className="quiet">Couldn’t reach: {status.failed.join(", ")}</p>}
          <p className="quiet small">
            {status.pending > 0 ? (
              `Updating ${status.pending} channel${status.pending === 1 ? "" : "s"}…`
            ) : (
              <>
                Updated {ago(new Date(Math.min(...channels.map((c) => feeds[c.id]?.fetchedAt ?? Date.now()))).toISOString())} ·{" "}
                <button className="link" onClick={() => refreshFeeds(true)}>Refresh</button>
              </>
            )}
          </p>
        </footer>
      )}
    </div>
  );
}
