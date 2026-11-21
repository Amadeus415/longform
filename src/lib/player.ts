import { useSyncExternalStore } from "react";
import { getState, resumePoint, saveProgress, updateSettings } from "./store";
import type { Video } from "./types";

// One player for the whole app, living outside React so audio never stops when views change.
//
// Listen: a plain <audio> element fed by /api/audio/:id. It keeps playing with the screen locked
//         and shows up on the lock screen through the Media Session API.
// Watch:  the official YouTube embed. If you lock the phone while watching, playback hands over
//         to Listen at the same second (iOS would otherwise stop the video).

export type Mode = "listen" | "watch";
export type PlayerState = {
  video: Video | null;
  mode: Mode;
  expanded: boolean;
  playing: boolean;
  loading: boolean;
  time: number;
  duration: number;
  error: string | null;
};

export const RATES = [1, 1.25, 1.5, 1.75, 2];

let ps: PlayerState = { video: null, mode: "listen", expanded: false, playing: false, loading: false, time: 0, duration: 0, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<PlayerState>) {
  ps = { ...ps, ...patch };
  listeners.forEach((l) => l());
}

export function usePlayer<T = PlayerState>(select: (s: PlayerState) => T = (s) => s as T): T {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => select(ps));
}

export function getPlayer(): PlayerState {
  return ps;
}

// ---------- the YouTube embed registers itself here while Watch mode is on ----------

export type Embed = {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  setPlaybackRate(rate: number): void;
};

let embed: Embed | null = null;
let embedPlayingAt = 0;

export function attachEmbed(next: Embed | null): void {
  embed = next;
}

/** Called by the embed on YouTube player state changes (1 playing, 2 paused, 3 buffering, 0 ended). */
export function embedStateChanged(state: number): void {
  if (state === 1) {
    embedPlayingAt = Date.now();
    set({ playing: true, loading: false, error: null });
  } else if (state === 2 || state === 0) {
    set({ playing: false });
    persist();
  } else if (state === 3) set({ loading: true });
}

export function embedTick(): void {
  if (!embed || ps.mode !== "watch") return;
  const time = embed.getCurrentTime() || 0;
  const duration = embed.getDuration() || ps.duration;
  if (ps.playing) embedPlayingAt = Date.now();
  set({ time, duration });
  persistEvery();
}

// ---------- audio element ----------

const audio = typeof Audio !== "undefined" ? new Audio() : (null as unknown as HTMLAudioElement);
let pendingSeek: number | null = null;

if (audio) {
  audio.preload = "auto";
  audio.setAttribute("playsinline", "");
  const listening = () => ps.mode === "listen";
  audio.addEventListener("playing", () => {
    if (!listening()) return;
    applyPendingSeek();
    pendingSeek = null;
    audio.playbackRate = getState().settings.rate; // Safari resets the rate when a new source loads
    set({ playing: true, loading: false, error: null });
  });
  audio.addEventListener("pause", () => {
    if (!listening()) return;
    set({ playing: false });
    persist();
  });
  audio.addEventListener("waiting", () => listening() && set({ loading: true }));
  audio.addEventListener("loadedmetadata", () => {
    applyPendingSeek();
    if (Number.isFinite(audio.duration)) set({ duration: audio.duration });
  });
  audio.addEventListener("canplay", applyPendingSeek);
  audio.addEventListener("timeupdate", () => {
    if (!listening() || pendingSeek !== null) return;
    set({ time: audio.currentTime });
    persistEvery();
    updatePosition();
  });
  audio.addEventListener("ended", () => {
    set({ playing: false });
    persist();
  });
  audio.addEventListener("error", () => {
    if (!listening() || !audio.getAttribute("src")) return;
    set({ playing: false, loading: false, error: "Couldn’t load the audio for this video. Try Watch instead." });
  });
}

/** Safari can ignore a seek made before the stream is seekable, so keep trying until it sticks. */
function applyPendingSeek(): void {
  if (pendingSeek === null) return;
  audio.currentTime = pendingSeek;
  if (Math.abs(audio.currentTime - pendingSeek) < 2) pendingSeek = null;
}

function audioSrc(id: string): string {
  return `/api/audio/${id}`;
}

function startAudio(video: Video, at: number): void {
  const src = audioSrc(video.id);
  if (audio.getAttribute("src") !== src) {
    audio.src = src;
    pendingSeek = at > 0 ? at : null;
    set({ loading: true });
  } else if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
    pendingSeek = at > 0 ? at : null;
  } else if (Math.abs(audio.currentTime - at) > 1) {
    audio.currentTime = at;
  }
  const rate = getState().settings.rate;
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
  // play() has to run synchronously inside the tap, before any await, or iOS refuses it.
  audio.play().catch((error: DOMException) => {
    if (error.name === "NotAllowedError") set({ playing: false, loading: false });
  });
}

/**
 * Watch mode: load this video's audio too, and call play() once inside the user's tap. iOS only lets
 * a media element start later without a tap (say, when the screen locks) if it was played in one.
 */
function primeAudio(video: Video): void {
  if (!getState().settings.continueOnLock) return;
  const src = audioSrc(video.id);
  if (audio.getAttribute("src") !== src) {
    audio.src = src;
    pendingSeek = null;
  }
  audio.muted = true;
  audio.play().catch(() => {});
  audio.pause();
  audio.muted = false;
}

// ---------- public controls ----------

export function play(video: Video, options: { mode?: Mode; at?: number; expand?: boolean } = {}): void {
  if (ps.video && ps.video.id !== video.id) persist();
  const mode = options.mode ?? getState().settings.mode;
  const at = options.at ?? (ps.video?.id === video.id ? currentTime() : resumePoint(video.id));
  set({
    video,
    mode,
    time: at,
    duration: video.seconds ?? 0,
    error: null,
    expanded: options.expand ?? (mode === "watch" || ps.expanded),
  });
  setMetadata(video);
  if (mode === "listen") startAudio(video, at);
  else {
    primeAudio(video);
    set({ loading: true, playing: false });
  }
}

export function setMode(mode: Mode, remember = true): void {
  if (remember) updateSettings({ mode });
  if (!ps.video || ps.mode === mode) return set({ mode });
  const at = currentTime();
  if (mode === "listen") {
    embed?.pauseVideo();
    set({ mode, time: at });
    startAudio(ps.video, at);
  } else {
    primeAudio(ps.video);
    set({ mode, time: at, expanded: true, playing: false, loading: true });
  }
}

/** Done with this one: it counts as finished (and leaves the feed if "Hide finished" is on). */
export function markFinished(): void {
  if (!ps.video) return;
  const d = ps.duration || ps.video.seconds || 0;
  if (d) saveProgress(ps.video, d, d);
  close();
}

export function toggle(): void {
  if (ps.playing) pause();
  else resume();
}

export function resume(): void {
  if (!ps.video) return;
  if (ps.mode === "watch") embed?.playVideo();
  else startAudio(ps.video, currentTime());
}

export function pause(): void {
  if (ps.mode === "watch") embed?.pauseVideo();
  else audio.pause();
}

export function seek(seconds: number): void {
  const t = Math.max(0, Math.min(seconds, ps.duration || seconds));
  if (ps.mode === "watch") embed?.seekTo(t, true);
  else if (pendingSeek !== null) pendingSeek = t;
  else audio.currentTime = t;
  set({ time: t });
}

export function skip(delta: number): void {
  seek(currentTime() + delta);
}

export function setRate(rate: number): void {
  updateSettings({ rate });
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
  embed?.setPlaybackRate(rate);
}

export function expand(): void {
  set({ expanded: true });
}

/** Close the big player. A video keeps going as audio, so you can browse while you listen. */
export function minimize(): void {
  if (ps.mode === "watch" && ps.video) {
    const at = currentTime();
    const wasPlaying = ps.playing;
    embed?.pauseVideo();
    set({ mode: "listen", time: at, expanded: false, playing: false, loading: false });
    if (wasPlaying) startAudio(ps.video, at);
  } else set({ expanded: false });
}

export function close(): void {
  persist();
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  embed?.pauseVideo();
  set({ video: null, expanded: false, playing: false, loading: false, error: null });
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
}

export function currentTime(): number {
  if (ps.mode === "watch" && embed) return embed.getCurrentTime() || ps.time;
  if (pendingSeek !== null) return pendingSeek;
  if (ps.video && audio?.getAttribute("src") === audioSrc(ps.video.id)) return audio.currentTime || ps.time;
  return ps.time;
}

/** Ask the server to look up a video's audio stream now, so pressing play later is instant. */
export function warm(id: string): void {
  fetch(`${audioSrc(id)}/warm`, { method: "POST" }).catch(() => {});
}

// ---------- progress ----------

let lastSaved = 0;
function persist(): void {
  if (!ps.video) return;
  const t = currentTime();
  const d = ps.duration || ps.video.seconds || 0;
  if (t > 1) saveProgress(ps.video, t, d);
  lastSaved = Date.now();
}

function persistEvery(): void {
  if (Date.now() - lastSaved > 10_000) persist();
}

// ---------- lock screen, background ----------

let positionAt = 0;
function updatePosition(): void {
  if (!("mediaSession" in navigator) || Date.now() - positionAt < 1000) return;
  positionAt = Date.now();
  const duration = ps.duration;
  if (!duration || !Number.isFinite(duration)) return;
  try {
    navigator.mediaSession.setPositionState({ duration, playbackRate: audio.playbackRate || 1, position: Math.min(ps.time, duration) });
  } catch {}
}

function setMetadata(video: Video): void {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: video.title,
    artist: video.channel,
    album: "Longform",
    artwork: [{ src: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`, sizes: "480x360", type: "image/jpeg" }],
  });
}

if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
  const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => resume()],
    ["pause", () => pause()],
    ["seekbackward", (d) => skip(-(d.seekOffset || 15))],
    ["seekforward", (d) => skip(d.seekOffset || 30)],
    ["seekto", (d) => d.seekTime !== undefined && seek(d.seekTime)],
  ];
  for (const [action, handler] of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {}
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    persist();
    // Locked the phone mid-video: keep going as audio from the same second.
    const watching = ps.mode === "watch" && ps.video && embed;
    const wasPlaying = embed && (embed.getPlayerState() === 1 || Date.now() - embedPlayingAt < 2000);
    if (watching && wasPlaying && getState().settings.continueOnLock) {
      const at = currentTime();
      embed!.pauseVideo();
      set({ mode: "listen", time: at });
      startAudio(ps.video!, at);
    }
  });
  window.addEventListener("pagehide", persist);
}
