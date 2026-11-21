import { useSyncExternalStore } from "react";
import { DEFAULT_RULES, describeChanges, normalizeRules, type Rules } from "./filter";
import type { ChannelFeed, Video } from "./types";

// All of your data lives in this browser: no account, no server-side profile.
// Each top-level key is saved to localStorage on its own.

export type Channel = { id: string; title: string };
export type Version = { v: number; at: number; rules: Rules; changes: string[]; note?: string };
export type Progress = {
  t: number; // seconds listened
  d: number; // duration
  at: number; // last played
  done?: boolean;
  video: Pick<Video, "id" | "title" | "channel" | "channelId" | "seconds" | "published">;
};
export type Settings = {
  mode: "listen" | "watch";
  frames: boolean;
  theme: "auto" | "light" | "dark";
  rate: number;
  continueOnLock: boolean;
};

export type State = {
  channels: Channel[];
  history: Version[];
  progress: Record<string, Progress>;
  settings: Settings;
  feeds: Record<string, ChannelFeed>;
};

const PREFIX = "longform.";
const isPhone = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

const DEFAULTS: State = {
  channels: [],
  history: [{ v: 1, at: Date.now(), rules: DEFAULT_RULES, changes: ["Default rules"] }],
  progress: {},
  settings: { mode: isPhone ? "listen" : "watch", frames: true, theme: "auto", rate: 1, continueOnLock: true },
  feeds: {},
};

function load<K extends keyof State>(key: K): State[K] {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) {
      const value = JSON.parse(raw);
      if (key === "settings") return { ...DEFAULTS.settings, ...value };
      if (key === "history" && (!Array.isArray(value) || !value.length)) return DEFAULTS[key];
      return value;
    }
  } catch {}
  return DEFAULTS[key];
}

let state: State = {
  channels: load("channels"),
  history: load("history"),
  progress: load("progress"),
  settings: load("settings"),
  feeds: load("feeds"),
};

const listeners = new Set<() => void>();
const dirty = new Set<keyof State>();
// Save the default rules once, so v1 keeps the date you first opened the app.
if (typeof localStorage !== "undefined" && !localStorage.getItem(PREFIX + "history")) dirty.add("history");
let saveTimer: ReturnType<typeof setTimeout> | undefined = dirty.size ? setTimeout(() => save(), 300) : undefined;

function save() {
  saveTimer = undefined;
  for (const key of dirty) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(state[key]));
    } catch {
      // Storage full: the feed cache is the only thing we can safely drop.
      if (key === "feeds") localStorage.removeItem(PREFIX + key);
    }
  }
  dirty.clear();
}

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const key of Object.keys(next) as (keyof State)[]) dirty.add(key);
  saveTimer ??= setTimeout(save, 300);
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => dirty.size && save());

export function useStore(): State {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
  );
}

// ---------- rules ----------

export function currentRules(s: State = state): Rules {
  return s.history[s.history.length - 1].rules;
}

/** Save a new version of the rules. Returns false when nothing changed. */
export function commitRules(next: Rules, note?: string): boolean {
  const rules = normalizeRules(next);
  const changes = describeChanges(currentRules(), rules);
  if (!changes.length) return false;
  setState((s) => ({
    history: [...s.history, { v: s.history[s.history.length - 1].v + 1, at: Date.now(), rules, changes, note: note?.trim() || undefined }],
  }));
  return true;
}

export function restoreVersion(v: number): void {
  const version = state.history.find((h) => h.v === v);
  if (version) commitRules(version.rules, `Restored v${v}`);
}

// ---------- channels ----------

export function addChannels(channels: Channel[]): number {
  const have = new Set(state.channels.map((c) => c.id));
  const fresh = channels.filter((c) => !have.has(c.id) && (have.add(c.id), true));
  if (fresh.length) {
    setState((s) => ({ channels: [...s.channels, ...fresh] }));
    navigator.storage?.persist?.().catch(() => {});
  }
  return fresh.length;
}

export function removeChannel(id: string): void {
  setState((s) => {
    const { [id]: _, ...feeds } = s.feeds;
    return { channels: s.channels.filter((c) => c.id !== id), feeds };
  });
}

// ---------- progress & settings ----------

export function saveProgress(video: Video, t: number, d: number): void {
  if (!d || !Number.isFinite(d)) return;
  const done = t >= d - 30;
  const { id, title, channel, channelId, seconds, published } = video;
  setState((s) => ({
    progress: { ...s.progress, [id]: { t: done ? d : t, d, at: Date.now(), done, video: { id, title, channel, channelId, seconds, published } } },
  }));
}

export function resumePoint(id: string): number {
  const p = state.progress[id];
  return p && !p.done && p.t > 15 ? Math.max(0, p.t - 3) : 0;
}

export function updateSettings(patch: Partial<Settings>): void {
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

// ---------- backup ----------

export function exportData(): string {
  const { channels, history, progress, settings } = state;
  return JSON.stringify({ app: "longform", version: 1, exportedAt: new Date().toISOString(), channels, history, progress, settings }, null, 2);
}

export function importData(json: string): void {
  const data = JSON.parse(json);
  if (data?.app !== "longform") throw new Error("This is not a Longform backup file.");
  const history: Version[] = Array.isArray(data.history) && data.history.length
    ? data.history.map((h: Version, i: number) => ({ ...h, v: Number(h.v) || i + 1, rules: normalizeRules(h.rules) }))
    : DEFAULTS.history;
  setState({
    channels: Array.isArray(data.channels) ? data.channels.filter((c: Channel) => /^UC[\w-]{22}$/.test(c?.id)) : [],
    history,
    progress: data.progress && typeof data.progress === "object" ? data.progress : {},
    settings: { ...DEFAULTS.settings, ...data.settings },
    feeds: {},
  });
}
