import { useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { normalizeRules } from "./filter";
import { normalizeNewsRules } from "./newsFilter";
import {
  DEFAULTS,
  applySyncedState,
  getSyncedSnapshot,
  onLocalSyncedChange,
  type Channel,
  type NewsVersion,
  type Progress,
  type SyncedState,
  type Version,
} from "./store";
import type { NewsSource } from "./types";

export type SyncStatus = {
  state: "idle" | "syncing" | "synced" | "offline" | "error";
  lastSyncedAt: number | null;
  error: string | null;
};

let status: SyncStatus = { state: "idle", lastSyncedAt: null, error: null };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => status);
}

const MAX_READ_HISTORY = 2000;

function isDefaultHistory(list: { v: number; changes?: string[] }[]): boolean {
  return list.length <= 1 && (list[0]?.v ?? 1) === 1 && (list[0]?.changes?.[0]?.startsWith("Default") ?? false);
}

function normalizeRemote(raw: Partial<SyncedState> | null | undefined): SyncedState | null {
  if (!raw || typeof raw !== "object") return null;
  const channels: Channel[] = Array.isArray(raw.channels)
    ? raw.channels.filter((c): c is Channel => Boolean(c && typeof c.id === "string" && typeof c.title === "string"))
    : [];
  const newsSources: NewsSource[] = Array.isArray(raw.newsSources)
    ? raw.newsSources.filter(
        (s): s is NewsSource => Boolean(s && typeof s.id === "string" && typeof s.title === "string" && (s.kind === "bsky" || s.kind === "rss" || s.kind === "hn")),
      )
    : [];
  const history: Version[] =
    Array.isArray(raw.history) && raw.history.length
      ? raw.history.map((h, i) => ({ ...h, v: Number(h.v) || i + 1, at: Number(h.at) || 0, rules: normalizeRules(h.rules) }))
      : DEFAULTS.history;
  const newsHistory: NewsVersion[] =
    Array.isArray(raw.newsHistory) && raw.newsHistory.length
      ? raw.newsHistory.map((h, i) => ({ ...h, v: Number(h.v) || i + 1, at: Number(h.at) || 0, rules: normalizeNewsRules(h.rules) }))
      : DEFAULTS.newsHistory;
  return {
    channels,
    history,
    progress: raw.progress && typeof raw.progress === "object" ? (raw.progress as Record<string, Progress>) : {},
    settings: { ...DEFAULTS.settings, ...(raw.settings ?? {}) },
    listened: raw.listened && typeof raw.listened === "object" ? raw.listened : {},
    newsSources,
    newsHistory,
    newsRead: raw.newsRead && typeof raw.newsRead === "object" ? raw.newsRead : {},
  };
}

/**
 * Deterministically merge local and remote user states so switching between web & phone
 * never loses channels, news sources, playback progress, or rule versions.
 */
export function mergeSyncedState(local: SyncedState, remote: SyncedState): { merged: SyncedState; needsPush: boolean } {
  // Channels: union by id, preferring remote order first, then any local-only additions.
  const channelMap = new Map<string, Channel>();
  for (const ch of remote.channels) channelMap.set(ch.id, ch);
  for (const ch of local.channels) {
    if (!channelMap.has(ch.id)) channelMap.set(ch.id, ch);
  }
  const channels = [...channelMap.values()];

  // News sources: union by id.
  const sourceMap = new Map<string, NewsSource>();
  for (const src of remote.newsSources) sourceMap.set(src.id, src);
  for (const src of local.newsSources) {
    if (!sourceMap.has(src.id)) sourceMap.set(src.id, src);
  }
  const newsSources = [...sourceMap.values()];

  // Progress: per video id, keep the most recently updated record.
  const progress: Record<string, Progress> = { ...remote.progress };
  for (const [id, entry] of Object.entries(local.progress)) {
    const existing = progress[id];
    if (!existing || (entry.at ?? 0) > (existing.at ?? 0)) {
      progress[id] = entry;
    }
  }

  // Daily listening totals: keep max seconds per day so neither device drops time.
  const listened: Record<string, number> = { ...remote.listened };
  for (const [day, sec] of Object.entries(local.listened)) {
    listened[day] = Math.max(listened[day] ?? 0, sec ?? 0);
  }

  // News read timestamps: union keeping latest timestamp, capped at MAX_READ_HISTORY.
  const readMap: Record<string, number> = { ...remote.newsRead };
  for (const [id, ts] of Object.entries(local.newsRead)) {
    readMap[id] = Math.max(readMap[id] ?? 0, ts ?? 0);
  }
  const readEntries = Object.entries(readMap);
  const newsRead =
    readEntries.length > MAX_READ_HISTORY
      ? Object.fromEntries(readEntries.sort((a, b) => b[1] - a[1]).slice(0, MAX_READ_HISTORY))
      : readMap;

  // Rule histories: prefer whichever has real edits (non-default) or the newer latest timestamp.
  const pickHistory = <T extends { v: number; at: number; changes?: string[] }>(loc: T[], rem: T[]): T[] => {
    const locDefault = isDefaultHistory(loc);
    const remDefault = isDefaultHistory(rem);
    if (locDefault && !remDefault) return rem;
    if (remDefault && !locDefault) return loc;
    const locAt = loc[loc.length - 1]?.at ?? 0;
    const remAt = rem[rem.length - 1]?.at ?? 0;
    return locAt > remAt ? loc : rem;
  };
  const history = pickHistory(local.history, remote.history);
  const newsHistory = pickHistory(local.newsHistory, remote.newsHistory);

  // Settings: prefer remote once synced, keeping local device's preferred playback mode if remote was empty.
  const settings = { ...local.settings, ...remote.settings };

  const merged: SyncedState = { channels, history, progress, settings, listened, newsSources, newsHistory, newsRead };
  const needsPush = JSON.stringify(merged) !== JSON.stringify(remote);
  return { merged, needsPush };
}

let active = false;
let unsubscribeStore: (() => void) | null = null;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | null = null;
let pendingPush = false;

export function startCloudSync(): void {
  if (active) return;
  active = true;
  unsubscribeStore = onLocalSyncedChange(() => {
    if (!active) return;
    pendingPush = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushStateNow().catch(() => {});
    }, 1500);
  });
  pullAndSync().catch(() => {});
}

export function stopCloudSync(): void {
  active = false;
  clearTimeout(pushTimer);
  pushTimer = undefined;
  pendingPush = false;
  unsubscribeStore?.();
  unsubscribeStore = null;
  setStatus({ state: "idle", lastSyncedAt: null, error: null });
}

export async function pullAndSync(): Promise<void> {
  if (!active) return;
  if (inflight) return inflight;
  inflight = (async () => {
    setStatus({ state: "syncing", error: null });
    try {
      const res = await apiFetch("/api/me/state", { cache: "no-store" });
      if (res.status === 503 || res.status === 401) {
        setStatus({ state: "idle", error: null });
        return;
      }
      if (!res.ok) throw new Error(`Sync failed (${res.status})`);
      const data = (await res.json()) as { state: Partial<SyncedState> | null; updatedAt: number; revision: number };
      const local = getSyncedSnapshot();
      const remote = normalizeRemote(data.state);

      if (!remote || data.revision === 0) {
        // First time syncing this account: upload local state if user already set anything up.
        const hasLocal =
          local.channels.length > 0 ||
          local.newsSources.length > 0 ||
          Object.keys(local.progress).length > 0 ||
          !isDefaultHistory(local.history) ||
          !isDefaultHistory(local.newsHistory);
        if (hasLocal) {
          await uploadSnapshot(local);
        } else {
          setStatus({ state: "synced", lastSyncedAt: Date.now(), error: null });
        }
        return;
      }

      const { merged, needsPush } = mergeSyncedState(local, remote);
      if (JSON.stringify(merged) !== JSON.stringify(local)) {
        applySyncedState(merged);
      }
      if (needsPush || pendingPush) {
        await uploadSnapshot(merged);
      } else {
        setStatus({ state: "synced", lastSyncedAt: Date.now(), error: null });
      }
    } catch (error) {
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      setStatus({ state: offline ? "offline" : "error", error: offline ? "Offline — changes saved on device" : (error as Error).message });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function uploadSnapshot(snapshot: SyncedState): Promise<void> {
  pendingPush = false;
  const res = await apiFetch("/api/me/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: snapshot }),
  });
  if (!res.ok) throw new Error(`Could not save changes (${res.status})`);
  setStatus({ state: "synced", lastSyncedAt: Date.now(), error: null });
}

export async function pushStateNow(): Promise<void> {
  if (!active) return;
  clearTimeout(pushTimer);
  pushTimer = undefined;
  setStatus({ state: "syncing", error: null });
  try {
    await uploadSnapshot(getSyncedSnapshot());
  } catch (error) {
    pendingPush = true;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    setStatus({ state: offline ? "offline" : "error", error: offline ? "Offline — will sync when back online" : (error as Error).message });
  }
}

export function flushPendingSync(): void {
  if (!active || !pendingPush) return;
  pushStateNow().catch(() => {});
}
