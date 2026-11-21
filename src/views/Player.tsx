import { useEffect, useRef, useState } from "react";
import { clock } from "../lib/filter";
import {
  RATES, attachEmbed, embedStateChanged, embedTick, expand, getPlayer, minimize, play, seek, setMode, setRate, skip, toggle, usePlayer,
} from "../lib/player";
import { getState, useStore } from "../lib/store";
import type { Video } from "../lib/types";
import { Frame, Icon, Segmented, Sheet, ago } from "./ui";

export function MiniPlayer() {
  const p = usePlayer();
  if (!p.video || p.expanded) return null;
  const pct = p.duration ? (p.time / p.duration) * 100 : 0;
  return (
    <div className="mini" role="region" aria-label="Now playing">
      <span className="mini-bar" style={{ width: `${pct}%` }} />
      <button className="mini-open" onClick={expand} aria-label="Open player">
        <span className="mini-title">{p.video.title}</span>
        <span className="meta">
          {p.error ? "Audio unavailable" : p.loading && !p.playing ? "Loading…" : `${clock(p.time)} / ${clock(p.duration)}`}
        </span>
      </button>
      <button className="icon-button" onClick={() => skip(-15)} aria-label="Back 15 seconds"><Icon name="back" /></button>
      <button className="icon-button" onClick={toggle} aria-label={p.playing ? "Pause" : "Play"}><Icon name={p.playing ? "pause" : "play"} size={26} /></button>
    </div>
  );
}

export function PlayerSheet() {
  const p = usePlayer();
  const { settings } = useStore();
  if (!p.video || !p.expanded) return null;
  const video = p.video;
  const watching = p.mode === "watch";
  const chapters = video.chapters ?? [];
  const current = chapters.findLastIndex(([t]) => t <= p.time + 0.5);

  return (
    <Sheet onClose={minimize} label="Player" wide={watching}>
      <div className="player">
        <div className="player-top">
          <button className="icon-button" onClick={minimize} aria-label="Minimize player"><Icon name="down" /></button>
          <Segmented value={p.mode} options={[["listen", "Listen"], ["watch", "Watch"]]} onChange={(m) => setMode(m)} />
          <a className="icon-button" href={`https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(p.time)}s`} target="_blank" rel="noreferrer" aria-label="Open on YouTube">
            <Icon name="external" size={20} />
          </a>
        </div>

        {watching ? <Watch video={video} /> : <Frame id={video.id} large />}

        <h2 className="player-title">{video.title}</h2>
        <p className="meta">{video.channel}{video.published ? ` · ${ago(video.published)}` : ""}</p>
        {p.error && <p className="error">{p.error}</p>}

        {!watching && (
          <>
            <Scrubber time={p.time} duration={p.duration} />
            <div className="controls">
              <button className="rate" onClick={() => setRate(RATES[(RATES.indexOf(settings.rate) + 1) % RATES.length])} aria-label="Playback speed">
                {settings.rate}×
              </button>
              <button className="icon-button big" onClick={() => skip(-15)} aria-label="Back 15 seconds"><Icon name="back" size={30} /></button>
              <button className="play" onClick={toggle} aria-label={p.playing ? "Pause" : "Play"}>
                {p.loading && !p.playing ? <span className="spinner" /> : <Icon name={p.playing ? "pause" : "play"} size={34} />}
              </button>
              <button className="icon-button big" onClick={() => skip(30)} aria-label="Forward 30 seconds"><Icon name="forward" size={30} /></button>
              <span className="rate" aria-hidden="true" />
            </div>
          </>
        )}

        {chapters.length > 0 && (
          <ol className="chapters">
            {chapters.map(([t, title], i) => (
              <li key={t}>
                <button
                  className={i === current ? "on" : ""}
                  onClick={() => {
                    seek(t);
                    if (!getPlayer().playing && !watching) play(video, { mode: "listen", at: t });
                  }}
                >
                  <span className="meta">{clock(t)}</span>
                  <span>{title}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Sheet>
  );
}

function Scrubber({ time, duration }: { time: number; duration: number }) {
  const [drag, setDrag] = useState<number | null>(null);
  const value = drag ?? time;
  const commit = () => {
    if (drag !== null) seek(drag);
    setDrag(null);
  };
  return (
    <div className="scrubber">
      <input
        type="range"
        min={0}
        max={Math.max(1, Math.floor(duration))}
        step={1}
        value={Math.floor(value)}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        aria-label="Seek"
        style={{ "--pct": `${duration ? (value / duration) * 100 : 0}%` } as React.CSSProperties}
      />
      <div className="times meta">
        <span>{clock(value)}</span>
        <span>−{clock(Math.max(0, duration - value))}</span>
      </div>
    </div>
  );
}

// ---------- the YouTube embed (Watch mode) ----------

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let api: Promise<any> | null = null;
function loadYouTubeApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  api ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.append(script);
  });
  return api;
}

function Watch({ video }: { video: Video }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let player: any;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    const start = Math.floor(getPlayer().time);
    loadYouTubeApi().then((YT) => {
      if (cancelled || !host.current) return;
      const mount = document.createElement("div");
      host.current.replaceChildren(mount);
      player = new YT.Player(mount, {
        host: "https://www.youtube-nocookie.com",
        videoId: video.id,
        width: "100%",
        height: "100%",
        playerVars: { start, autoplay: 1, playsinline: 1, rel: 0, iv_load_policy: 3 },
        events: {
          onReady: () => {
            attachEmbed(player);
            player.setPlaybackRate?.(getState().settings.rate);
            player.playVideo();
          },
          onStateChange: (e: { data: number }) => embedStateChanged(e.data),
        },
      });
      timer = setInterval(embedTick, 500);
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      attachEmbed(null);
      player?.destroy?.();
    };
  }, [video.id]);
  return <div className="embed" ref={host} />;
}
