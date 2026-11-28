import { useSyncExternalStore } from "react";
import { DEFAULT_RULES, describeChanges, lookupJudgment, normalizeRules, type Rules } from "./filter";
import { DEFAULT_NEWS_RULES, describeNewsChanges, normalizeNewsRules, type NewsRules } from "./newsFilter";
import { normalizeRatingScore, sanitizeRatingsMap } from "./ratings";
import type {
  ChannelFeed,
  DiscoverFeed,
  LlmJudgment,
  NewsSource,
  NewsSourceFeed,
  SyncTombstones,
  Video,
  VideoRating,
} from "./types";

// All of your data lives locally first for instant startup & offline reading,
// and syncs automatically to your account when signed in on a cloud server.

export type Channel = { id: string; title: string; addedAt?: number };
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

export type SyncedDiscoverEdition = {
  editionDay: string;
  lockedIds: string[];
};

export type SyncedState = {
  channels: Channel[];
  blockedChannels: Channel[];
  history: Version[];
  progress: Record<string, Progress>;
  ratings: Record<string, VideoRating>;
  settings: Settings;
  listened: Record<string, number>;
  listenedByDevice?: Record<string, Record<string, number>>;
  newsSources: NewsSource[];
  newsHistory: NewsVersion[];
  newsRead: Record<string, number>;
  tombstones?: SyncTombstones;
  discoverEdition?: SyncedDiscoverEdition | null;
};

export type State = SyncedState & {
  tombstones: SyncTombstones;
  listenedByDevice: Record<string, Record<string, number>>;
  feeds: Record<string, ChannelFeed>;
  discover: DiscoverFeed | null;
  judgments: Record<string, LlmJudgment>;
  newsFeeds: Record<string, NewsSourceFeed>;
};

export const SYNCED_KEYS: (keyof SyncedState)[] = [
  "channels",
  "blockedChannels",
  "history",
  "progress",
  "ratings",
  "settings",
  "listened",
  "listenedByDevice",
  "newsSources",
  "newsHistory",
  "newsRead",
  "tombstones",
  "discoverEdition",
];

const SYNCED_KEY_SET = new Set<keyof State>(SYNCED_KEYS);
const MAX_PROGRESS_HISTORY = 1_500;
const MAX_TOMBSTONES = 1_000;

const PREFIX = "longform.";
const isPhone = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(PREFIX + "deviceId");
    if (existing && /^[a-zA-Z0-9_-]{4,48}$/.test(existing)) return existing;
    const fresh = `dev_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    localStorage.setItem(PREFIX + "deviceId", fresh);
    return fresh;
  } catch {
    return "dev_local";
  }
}

export function emptyTombstones(): SyncTombstones {
  return { channels: {}, blockedChannels: {}, ratings: {}, newsSources: {} };
}

function normalizeTombstones(raw: unknown): SyncTombstones {
  const obj = raw && typeof raw === "object" ? (raw as Partial<SyncTombstones>) : {};
  const cleanMap = (m: unknown): Record<string, number> => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return {};
    const entries = Object.entries(m as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] > 0,
    );
    if (entries.length > MAX_TOMBSTONES) {
      entries.sort((a, b) => b[1] - a[1]);
      return Object.fromEntries(entries.slice(0, MAX_TOMBSTONES));
    }
    return Object.fromEntries(entries);
  };
  return {
    channels: cleanMap(obj.channels),
    blockedChannels: cleanMap(obj.blockedChannels),
    ratings: cleanMap(obj.ratings),
    newsSources: cleanMap(obj.newsSources),
  };
}

export const DEFAULTS: State = {
  channels: [],
  blockedChannels: [],
  history: [{ v: 1, at: Date.now(), rules: DEFAULT_RULES, changes: ["Default rules"] }],
  progress: {},
  ratings: {},
  settings: { mode: isPhone ? "listen" : "watch", frames: true, theme: "auto", rate: 1, continueOnLock: true },
  feeds: {},
  discover: null,
  judgments: {},
  listened: {},
  listenedByDevice: {},
  newsSources: [],
  newsHistory: [{ v: 1, at: Date.now(), rules: DEFAULT_NEWS_RULES, changes: ["Default news rules"] }],
  newsRead: {},
  newsFeeds: {},
  tombstones: emptyTombstones(),
  discoverEdition: null,
};

function load<K extends keyof State>(key: K): State[K] {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) {
      const value = JSON.parse(raw);
      if (key === "settings") return { ...DEFAULTS.settings, ...value };
      if (key === "ratings") return sanitizeRatingsMap(value) as State[K];
      if (key === "tombstones") return normalizeTombstones(value) as State[K];
      if (key === "history") {
        if (!Array.isArray(value) || !value.length) return DEFAULTS.history as State[K];
        return value.map((h: Version, i: number) => ({
          ...h,
          v: Number(h.v) || i + 1,
          rules: normalizeRules(h.rules),
        })) as State[K];
      }
      if (key === "newsHistory" && (!Array.isArray(value) || !value.length)) return DEFAULTS[key];
      return value;
    }
  } catch {}
  return DEFAULTS[key];
}

let state: State = {
  channels: load("channels"),
  blockedChannels: load("blockedChannels"),
  history: load("history"),
  progress: load("progress"),
  ratings: load("ratings"),
  settings: load("settings"),
  feeds: load("feeds"),
  discover: load("discover"),
  judgments: load("judgments"),
  listened: load("listened"),
  listenedByDevice: load("listenedByDevice"),
  newsSources: load("newsSources"),
  newsHistory: load("newsHistory"),
  newsRead: load("newsRead"),
  newsFeeds: load("newsFeeds"),
  tombstones: load("tombstones"),
  discoverEdition: load("discoverEdition"),
};

const listeners = new Set<() => void>();
const localMutationListeners = new Set<(changedKeys: (keyof State)[]) => void>();
const dirty = new Set<keyof State>();
if (typeof localStorage !== "undefined" && !localStorage.getItem(PREFIX + "history")) dirty.add("history");
if (typeof localStorage !== "undefined" && !localStorage.getItem(PREFIX + "newsHistory")) dirty.add("newsHistory");
let saveTimer: ReturnType<typeof setTimeout> | undefined = dirty.size ? setTimeout(() => save(), 300) : undefined;

function save() {
  saveTimer = undefined;
  for (const key of dirty) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(state[key]));
    } catch {
      if (key === "feeds" || key === "newsFeeds" || key === "discover" || key === "judgments") {
        localStorage.removeItem(PREFIX + key);
      }
    }
  }
  dirty.clear();
}

export function getState(): State {
  return state;
}

export function getSyncedSnapshot(s: State = state): SyncedState {
  return {
    channels: s.channels,
    blockedChannels: s.blockedChannels,
    history: s.history,
    progress: s.progress,
    ratings: s.ratings,
    settings: s.settings,
    listened: s.listened,
    listenedByDevice: s.listenedByDevice,
    newsSources: s.newsSources,
    newsHistory: s.newsHistory,
    newsRead: s.newsRead,
    tombstones: s.tombstones,
    discoverEdition: s.discoverEdition ?? null,
  };
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>), options?: { fromSync?: boolean }): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  const keys = Object.keys(next) as (keyof State)[];
  const syncedKeys: (keyof State)[] = [];
  for (const key of keys) {
    dirty.add(key);
    if (SYNCED_KEY_SET.has(key)) syncedKeys.push(key);
  }
  saveTimer ??= setTimeout(save, 300);
  listeners.forEach((listener) => listener());
  if (syncedKeys.length && !options?.fromSync) {
    localMutationListeners.forEach((listener) => listener(syncedKeys));
  }
}

/** Subscribe specifically to local mutations of user-synced keys (for cloud sync). */
export function onLocalSyncedChange(listener: (changedKeys: (keyof State)[]) => void): () => void {
  localMutationListeners.add(listener);
  return () => localMutationListeners.delete(listener);
}

/** Apply merged state pulled from the server without triggering an immediate echo push. */
export function applySyncedState(next: SyncedState): void {
  setState(
    {
      channels: next.channels,
      blockedChannels: next.blockedChannels ?? [],
      history: next.history,
      progress: next.progress,
      ratings: sanitizeRatingsMap(next.ratings),
      settings: { ...DEFAULTS.settings, ...next.settings },
      listened: next.listened,
      listenedByDevice: next.listenedByDevice ?? {},
      newsSources: next.newsSources,
      newsHistory: next.newsHistory,
      newsRead: next.newsRead,
      tombstones: normalizeTombstones(next.tombstones),
      discoverEdition: next.discoverEdition ?? null,
    },
    { fromSync: true },
  );
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

// ---------- channels (with deletion tombstones) ----------

export function addChannels(channels: Channel[]): number {
  const have = new Set(state.channels.map((c) => c.id));
  const now = Date.now();
  const fresh = channels
    .filter((c) => !have.has(c.id) && (have.add(c.id), true))
    .map((c) => ({ ...c, addedAt: c.addedAt ?? now }));
  if (fresh.length) {
    const addedIds = new Set(fresh.map((c) => c.id));
    setState((s) => {
      const chTombs = { ...s.tombstones.channels };
      for (const id of addedIds) delete chTombs[id];
      return {
        channels: [...s.channels, ...fresh],
        blockedChannels: s.blockedChannels.filter((b) => !addedIds.has(b.id)),
        tombstones: { ...s.tombstones, channels: chTombs },
      };
    });
    navigator.storage?.persist?.().catch(() => {});
  }
  return fresh.length;
}

export function removeChannel(id: string): void {
  setState((s) => {
    const { [id]: _, ...feeds } = s.feeds;
    return {
      channels: s.channels.filter((c) => c.id !== id),
      feeds,
      tombstones: {
        ...s.tombstones,
        channels: { ...s.tombstones.channels, [id]: Date.now() },
      },
    };
  });
}

export function blockChannel(channel: Channel): void {
  if (!channel.id) return;
  setState((s) => {
    if (s.blockedChannels.some((b) => b.id === channel.id)) return {};
    const blockedTombs = { ...s.tombstones.blockedChannels };
    delete blockedTombs[channel.id];
    return {
      blockedChannels: [...s.blockedChannels, { ...channel, addedAt: channel.addedAt ?? Date.now() }],
      tombstones: { ...s.tombstones, blockedChannels: blockedTombs },
    };
  });
}

export function unblockChannel(id: string): void {
  setState((s) => ({
    blockedChannels: s.blockedChannels.filter((b) => b.id !== id),
    tombstones: {
      ...s.tombstones,
      blockedChannels: { ...s.tombstones.blockedChannels, [id]: Date.now() },
    },
  }));
}

// ---------- news sources & read state ----------

export function addNewsSources(sources: NewsSource[]): number {
  const have = new Set(state.newsSources.map((s) => s.id));
  const now = Date.now();
  const fresh = sources
    .filter((s) => !have.has(s.id) && (have.add(s.id), true))
    .map((s) => ({ ...s, addedAt: s.addedAt ?? now }));
  if (fresh.length) {
    setState((s) => {
      const tombs = { ...s.tombstones.newsSources };
      for (const src of fresh) delete tombs[src.id];
      return {
        newsSources: [...s.newsSources, ...fresh],
        tombstones: { ...s.tombstones, newsSources: tombs },
      };
    });
    navigator.storage?.persist?.().catch(() => {});
  }
  return fresh.length;
}

export function removeNewsSource(id: string): void {
  setState((s) => {
    const { [id]: _, ...newsFeeds } = s.newsFeeds;
    return {
      newsSources: s.newsSources.filter((src) => src.id !== id),
      newsFeeds,
      tombstones: {
        ...s.tombstones,
        newsSources: { ...s.tombstones.newsSources, [id]: Date.now() },
      },
    };
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

// ---------- progress & settings (with automatic pruning) ----------

function pruneProgress(map: Record<string, Progress>): Record<string, Progress> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_PROGRESS_HISTORY) return map;
  entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
  return Object.fromEntries(entries.slice(0, MAX_PROGRESS_HISTORY));
}

export function saveProgress(video: Video, t: number, d: number): void {
  if (!d || !Number.isFinite(d)) return;
  const done = t >= d - 30;
  const { id, title, channel, channelId, seconds, published } = video;
  setState((s) => ({
    progress: pruneProgress({
      ...s.progress,
      [id]: { t: done ? d : t, d, at: Date.now(), done, video: { id, title, channel, channelId, seconds, published } },
    }),
  }));
}

export function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Count real time spent with a video toward today's total (tracked per device so multi-device totals sum accurately). */
export function addListened(seconds: number): void {
  if (!(seconds > 0) || seconds > 3600) return;
  const key = dayKey();
  const devId = getDeviceId();
  setState((s) => {
    const devMap = { ...(s.listenedByDevice[devId] ?? {}), [key]: (s.listenedByDevice[devId]?.[key] ?? 0) + seconds };
    const nextByDevice = { ...s.listenedByDevice, [devId]: devMap };
    let sumToday = 0;
    for (const m of Object.values(nextByDevice)) sumToday += m[key] ?? 0;
    return {
      listenedByDevice: nextByDevice,
      listened: { ...s.listened, [key]: Math.max((s.listened[key] ?? 0) + seconds, sumToday) },
    };
  });
}

export function resumePoint(id: string): number {
  const p = state.progress[id];
  return p && !p.done && p.t > 15 ? Math.max(0, p.t - 3) : 0;
}

export function updateSettings(patch: Partial<Settings>): void {
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

// ---------- video ratings (1–10, with deletion tombstones) ----------

export function rateVideo(
  video: Video,
  rawScore: number,
  options?: { note?: string; judgment?: LlmJudgment },
): VideoRating | null {
  const score = normalizeRatingScore(rawScore);
  if (score === null || !video?.id) return null;
  const existing = state.ratings[video.id];
  const judgment = options?.judgment ?? lookupJudgment(video.id, currentRules(), state.judgments);
  const note =
    options && "note" in options
      ? options.note?.trim().slice(0, 280) || undefined
      : existing?.note;
  const entry: VideoRating = {
    videoId: video.id,
    score,
    ratedAt: Date.now(),
    ...(note ? { note } : {}),
    title: video.title || existing?.title || "",
    channel: video.channel || existing?.channel || "",
    channelId: video.channelId || existing?.channelId || "",
    ...(video.published || existing?.published ? { published: video.published || existing?.published } : {}),
    seconds: video.seconds ?? existing?.seconds ?? null,
    ...(video.source || existing?.source ? { source: video.source ?? existing?.source } : {}),
    ...(judgment
      ? {
          aiScore: judgment.score,
          aiBrainrot: judgment.brainrot,
          ...(judgment.category ? { aiCategory: judgment.category } : {}),
          ...(judgment.reason ? { aiReason: judgment.reason } : {}),
        }
      : existing?.aiScore !== undefined
        ? {
            aiScore: existing.aiScore,
            ...(existing.aiBrainrot !== undefined ? { aiBrainrot: existing.aiBrainrot } : {}),
            ...(existing.aiCategory ? { aiCategory: existing.aiCategory } : {}),
            ...(existing.aiReason ? { aiReason: existing.aiReason } : {}),
          }
        : {}),
  };
  setState((s) => {
    const ratingTombs = { ...s.tombstones.ratings };
    delete ratingTombs[video.id];
    return {
      ratings: sanitizeRatingsMap({ ...s.ratings, [video.id]: entry }),
      tombstones: { ...s.tombstones, ratings: ratingTombs },
    };
  });
  return entry;
}

export function clearVideoRating(videoId: string): void {
  if (!state.ratings[videoId]) return;
  setState((s) => {
    const { [videoId]: _, ...rest } = s.ratings;
    return {
      ratings: rest,
      tombstones: {
        ...s.tombstones,
        ratings: { ...s.tombstones.ratings, [videoId]: Date.now() },
      },
    };
  });
}

// ---------- backup ----------

export function exportData(): string {
  const { channels, blockedChannels, history, progress, ratings, settings, listened, newsSources, newsHistory, newsRead, tombstones } = state;
  return JSON.stringify(
    {
      app: "longform",
      version: 5,
      exportedAt: new Date().toISOString(),
      channels,
      blockedChannels,
      history,
      progress,
      ratings,
      settings,
      listened,
      newsSources,
      newsHistory,
      newsRead,
      tombstones,
    },
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
    blockedChannels: Array.isArray(data.blockedChannels) ? data.blockedChannels.filter((c: Channel) => /^UC[\w-]{22}$/.test(c?.id)) : [],
    history,
    progress: data.progress && typeof data.progress === "object" ? pruneProgress(data.progress) : {},
    ratings: sanitizeRatingsMap(data.ratings),
    settings: { ...DEFAULTS.settings, ...data.settings },
    listened: data.listened && typeof data.listened === "object" ? data.listened : {},
    tombstones: normalizeTombstones(data.tombstones),
    feeds: {},
    discover: null,
    judgments: {},
    newsSources,
    newsHistory,
    newsRead: data.newsRead && typeof data.newsRead === "object" ? data.newsRead : {},
    newsFeeds: {},
  });
}
