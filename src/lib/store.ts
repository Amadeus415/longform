import { useSyncExternalStore } from "react";
import { DEFAULT_RULES, describeChanges, normalizeRules, type Rules } from "./filter";
import { DEFAULT_NEWS_RULES, describeNewsChanges, normalizeNewsRules, type NewsRules } from "./newsFilter";
import type { ChannelFeed, NewsSource, NewsSourceFeed, Video } from "./types";

// All of your data lives in this browser: no account, no server-side profile.
// Each top-level key is saved to localStorage on its own.

export type Channel = { id: string; title: string };
export type Version = { v: number; at: number; rules: Rules; changes: string[]; note?: string };
export type NewsVersion = { v: number; at: number; rules: NewsRules; changes: string[]; note?: string };
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
  /** Seconds listened or watched per local day ("2026-11-20"), for the weekly summary. */
  listened: Record<string, number>;
  newsSources: NewsSource[];
  newsHistory: NewsVersion[];
  /** News item IDs marked read (id -> epoch ms). */
  newsRead: Record<string, number>;
  newsFeeds: Record<string, NewsSourceFeed>;
};

const PREFIX = "longform.";
const isPhone = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

const DEFAULTS: State = {
  channels: [],
  history: [{ v: 1, at: Date.now(), rules: DEFAULT_RULES, changes: ["Default rules"] }],
  progress: {},
  settings: { mode: isPhone ? "listen" : "watch", frames: true, theme: "auto", rate: 1, continueOnLock: true },
  feeds: {},
  listened: {},
  newsSources: [],
  newsHistory: [{ v: 1, at: Date.now(), rules: DEFAULT_NEWS_RULES, changes: ["Default news rules"] }],
  newsRead: {},
  newsFeeds: {},
};

function load<K extends keyof State>(key: K): State[K] {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) {
      const value = JSON.parse(raw);
      if (key === "settings") return { ...DEFAULTS.settings, ...value };
      if ((key === "history" || key === "newsHistory") && (!Array.isArray(value) || !value.length)) return DEFAULTS[key];
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
  listened: load("listened"),
  newsSources: load("newsSources"),
  newsHistory: load("newsHistory"),
  newsRead: load("newsRead"),
  newsFeeds: load("newsFeeds"),
};

const listeners = new Set<() => void>();
const dirty = new Set<keyof State>();
// Save the default rules once, so v1 keeps the date you first opened the app.
if (typeof localStorage !== "undefined" && !localStorage.getItem(PREFIX + "history")) dirty.add("history");
if (typeof localStorage !== "undefined" && !localStorage.getItem(PREFIX + "newsHistory")) dirty.add("newsHistory");
let saveTimer: ReturnType<typeof setTimeout> | undefined = dirty.size ? setTimeout(() => save(), 300) : undefined;

function save() {
  saveTimer = undefined;
  for (const key of dirty) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(state[key]));
    } catch {
      // Storage full: the feed caches are the only things we can safely drop.
      if (key === "feeds" || key === "newsFeeds") localStorage.removeItem(PREFIX + key);
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

/** Subscribe to the store. Pass a selector to re-render only when that slice changes. */
export function useStore<T = State>(select: (s: State) => T = (s) => s as T): T {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => select(state),
  );
}

// ---------- video rules ----------

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

// ---------- news rules ----------

export function currentNewsRules(s: State = state): NewsRules {
  return s.newsHistory[s.newsHistory.length - 1].rules;
}

export function commitNewsRules(next: NewsRules, note?: string): boolean {
  const rules = normalizeNewsRules(next);
  const changes = describeNewsChanges(currentNewsRules(), rules);
  if (!changes.length) return false;
  setState((s) => ({
    newsHistory: [
      ...s.newsHistory,
      { v: s.newsHistory[s.newsHistory.length - 1].v + 1, at: Date.now(), rules, changes, note: note?.trim() || undefined },
    ],
  }));
  return true;
}

export function restoreNewsVersion(v: number): void {
  const version = state.newsHistory.find((h) => h.v === v);
  if (version) commitNewsRules(version.rules, `Restored v${v}`);
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

// ---------- news sources & read state ----------

export function addNewsSources(sources: NewsSource[]): number {
  const have = new Set(state.newsSources.map((s) => s.id));
  const fresh = sources.filter((s) => !have.has(s.id) && (have.add(s.id), true));
  if (fresh.length) {
    setState((s) => ({ newsSources: [...s.newsSources, ...fresh] }));
    navigator.storage?.persist?.().catch(() => {});
  }
  return fresh.length;
}

export function removeNewsSource(id: string): void {
  setState((s) => {
    const { [id]: _, ...newsFeeds } = s.newsFeeds;
    return { newsSources: s.newsSources.filter((src) => src.id !== id), newsFeeds };
  });
}

const MAX_READ_HISTORY = 2000;

export function markNewsRead(ids: string[]): void {
  if (!ids.length) return;
  const now = Date.now();
  setState((s) => {
    const next: Record<string, number> = { ...s.newsRead };
    for (const id of ids) next[id] = now;
    const entries = Object.entries(next);
    if (entries.length > MAX_READ_HISTORY) {
      entries.sort((a, b) => b[1] - a[1]);
      return { newsRead: Object.fromEntries(entries.slice(0, MAX_READ_HISTORY)) };
    }
    return { newsRead: next };
  });
}

export function markNewsUnread(ids: string[]): void {
  if (!ids.length) return;
  setState((s) => {
    const next = { ...s.newsRead };
    for (const id of ids) delete next[id];
    return { newsRead: next };
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

export function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Count real time spent with a video toward today's total. */
export function addListened(seconds: number): void {
  if (!(seconds > 0) || seconds > 3600) return;
  const key = dayKey();
  setState((s) => ({ listened: { ...s.listened, [key]: (s.listened[key] ?? 0) + seconds } }));
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
  const { channels, history, progress, settings, newsSources, newsHistory, newsRead } = state;
  return JSON.stringify(
    { app: "longform", version: 2, exportedAt: new Date().toISOString(), channels, history, progress, settings, newsSources, newsHistory, newsRead },
    null,
    2,
  );
}

export function importData(json: string): void {
  const data = JSON.parse(json);
  if (data?.app !== "longform") throw new Error("This is not a Longform backup file.");
  const history: Version[] = Array.isArray(data.history) && data.history.length
    ? data.history.map((h: Version, i: number) => ({ ...h, v: Number(h.v) || i + 1, rules: normalizeRules(h.rules) }))
    : DEFAULTS.history;
  const newsHistory: NewsVersion[] = Array.isArray(data.newsHistory) && data.newsHistory.length
    ? data.newsHistory.map((h: NewsVersion, i: number) => ({ ...h, v: Number(h.v) || i + 1, rules: normalizeNewsRules(h.rules) }))
    : DEFAULTS.newsHistory;
  const newsSources: NewsSource[] = Array.isArray(data.newsSources)
    ? data.newsSources.filter((s: NewsSource) => typeof s?.id === "string" && typeof s?.title === "string" && (s.kind === "bsky" || s.kind === "rss" || s.kind === "hn"))
    : [];
  setState({
    channels: Array.isArray(data.channels) ? data.channels.filter((c: Channel) => /^UC[\w-]{22}$/.test(c?.id)) : [],
    history,
    progress: data.progress && typeof data.progress === "object" ? data.progress : {},
    settings: { ...DEFAULTS.settings, ...data.settings },
    feeds: {},
    newsSources,
    newsHistory,
    newsRead: data.newsRead && typeof data.newsRead === "object" ? data.newsRead : {},
    newsFeeds: {},
  });
}
