import { useEffect, useRef, useState } from "react";
import { clock } from "../lib/filter";
import {
  RATES, attachEmbed, close as stop, embedStateChanged, embedTick, expand, getPlayer, minimize, play, seek, setMode, setRate, skip, toggle,
  usePlayer,
} from "../lib/player";
import { getState, useStore } from "../lib/store";
import type { Video } from "../lib/types";
import { finish } from "./actions";
import { Avatar, Frame, Icon, Segmented, ago, showActions } from "./ui";

export function MiniPlayer() {
  const p = usePlayer();
  const visible = !!p.video;
  useEffect(() => {
    document.documentElement.classList.toggle("has-mini", visible);
  }, [visible]);
  if (!p.video || p.expanded) return null;
  const pct = p.duration ? (p.time / p.duration) * 100 : 0;
  return (
    <div className="mini glass" role="region" aria-label="Now playing">
      <img className="mini-glow" src={`https://i.ytimg.com/vi/${p.video.id}/mq2.jpg`} alt="" aria-hidden="true" />
      <div className="mini-body">
        <button className="mini-open" onClick={expand} aria-label="Open player">
          <span className="media"><Frame id={p.video.id} size="small" /></span>
          <span style={{ minWidth: 0 }}>
            <div className="t">{p.video.title}</div>
            <div className="s">{p.error ? "Audio unavailable. Open to watch instead." : p.video.channel}</div>
          </span>
        </button>
        <button className="icon-btn" onClick={toggle} aria-label={p.playing ? "Pause" : "Play"}>
          {p.loading && !p.playing ? <span className="spinner" style={{ width: 22, height: 22, borderColor: "var(--line)", borderTopColor: "var(--text)" }} /> : <Icon name={p.playing ? "pause" : "play"} size={28} />}
        </button>
        <button className="icon-btn" onClick={() => skip(30)} aria-label="Forward 30 seconds"><Icon name="forward" size={26} label="30" /></button>
      </div>
      <div className="bar"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function PlayerSheet() {
  const p = usePlayer();
  const rate = useStore((s) => s.settings.rate);
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const drag = useRef<{ x: number; y: number; dy: number; at: number; active: boolean } | null>(null);

  useEffect(() => {
    if (!p.expanded) return;
    setClosing(false);
    document.documentElement.classList.add("sheet-open", "player-open");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove("sheet-open", "player-open");
      window.removeEventListener("keydown", onKey);
    };
  }, [p.expanded]);

  if (!p.video || !p.expanded) return null;
  const video = p.video;
  const watching = p.mode === "watch";
  const chapters = video.chapters ?? [];
  const current = chapters.findLastIndex(([t]) => t <= p.time + 0.5);

  function close() {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      minimize();
    }, 230);
  }

  // Drag down from the top area (or anywhere while scrolled to the top) to minimize.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a, iframe")) return;
    if ((scroller.current?.scrollTop ?? 0) > 0 && !(e.target as HTMLElement).closest("[data-drag]")) return;
    drag.current = { x: e.clientX, y: e.clientY, dy: 0, at: Date.now(), active: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    const dx = Math.abs(e.clientX - d.x);
    if (!d.active && dy > 8 && dy > dx * 1.5) d.active = true;
    if (!d.active) return;
    d.dy = Math.max(0, dy);
    panel.current!.style.transition = "none";
    panel.current!.style.transform = `translateY(${d.dy}px)`;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    panel.current!.style.transition = "";
    const fast = d.dy / Math.max(1, Date.now() - d.at) > 0.5;
    if (d.dy > 120 || (fast && d.dy > 40)) close();
    else panel.current!.style.transform = "";
  };

  // Finishing closes the player; the toast offers Undo.
  function done() {
    finish({ ...video, seconds: video.seconds || p.duration || null });
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      stop();
    }, 230);
  }

  const more = () =>
    showActions({
      title: video.title,
      subtitle: video.channel,
      actions: [
        { icon: "done", label: "Mark as finished", run: done },
        { icon: "external", label: "Open in YouTube", run: () => window.open(`https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(p.time)}s`, "_blank") },
      ],
    });

  return (
    <div className={`player-root${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label="Now playing">
      <div className="scrim" onClick={close} />
      <div ref={panel} className={`player${watching ? " wide" : ""}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <img className="ambient" src={`https://i.ytimg.com/vi/${video.id}/hq2.jpg`} alt="" aria-hidden="true" />
        <div className="vignette" />
        <div className="player-scroll" ref={scroller}>
          <div className="player-top" data-drag>
            <button className="icon-btn" onClick={close} aria-label="Minimize player"><Icon name="down" size={28} /></button>
            <Segmented value={p.mode} options={[["listen", "Audio"], ["watch", "Video"]]} onChange={(m) => setMode(m)} />
            <button className="icon-btn" onClick={more} aria-label="More"><Icon name="more" /></button>
          </div>

          {watching ? (
            <Watch video={video} />
          ) : (
            <div className={`artwork media${p.playing || p.loading ? "" : " paused"}`} data-drag>
              <Frame id={video.id} />
            </div>
          )}

          <h2 className="np-title">{video.title}</h2>
          <div className="np-channel">
            <Avatar id={video.channelId} title={video.channel} size={24} />
            <span>{video.channel}{video.published ? ` · ${ago(video.published)}` : ""}</span>
          </div>
          {p.error && <p className="np-error">{p.error}</p>}

          {!watching && (
            <>
              <Scrubber time={p.time} duration={p.duration} />
              <div className="transport">
                <button className="speed" onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])} aria-label={`Playback speed ${rate}×`}>{rate}×</button>
                <button className="icon-btn" onClick={() => skip(-15)} aria-label="Back 15 seconds"><Icon name="back" size={34} label="15" /></button>
                <button className="play-btn" onClick={toggle} aria-label={p.playing ? "Pause" : "Play"}>
                  {p.loading && !p.playing ? <span className="spinner" /> : <Icon name={p.playing ? "pause" : "play"} size={34} />}
                </button>
                <button className="icon-btn" onClick={() => skip(30)} aria-label="Forward 30 seconds"><Icon name="forward" size={34} label="30" /></button>
                <button className="icon-btn" onClick={done} aria-label="Mark as finished"><Icon name="done" size={26} /></button>
              </div>
            </>
          )}

          {chapters.length > 0 && (
            <>
              <h3 className="chapters-head">Chapters</h3>
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
                      <span className="time">{clock(t)}</span>
                      <span>{title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </div>
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
      <div className="times">
        <span>{clock(value)}</span>
        <span>−{clock(Math.max(0, duration - value))}</span>
      </div>
    </div>
  );
}

// ---------- the YouTube embed (Video mode) ----------

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
