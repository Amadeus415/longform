import { useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { normalizeRules } from "./filter";
import { normalizeNewsRules } from "./newsFilter";
import { sanitizeRatingsMap } from "./ratings";
import {
  DEFAULTS,
  applySyncedState,
  dayKey,
  emptyTombstones,
  getDeviceId,
  getState,
  getSyncedSnapshot,
  onLocalSyncedChange,
  type Channel,
  type NewsVersion,
  type Progress,
  type State,
  type SyncedState,
  type Version,
} from "./store";
import type { NewsSource, SyncTombstones, VideoRating } from "./types";

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
const MAX_PROGRESS_HISTORY = 1500;
const PROGRESS_ONLY_KEYS = new Set<keyof State>(["progress", "listened", "listenedByDevice"]);

function isDefaultHistory(list: { v: number; changes?: string[] }[]): boolean {
  return list.length <= 1 && (list[0]?.v ?? 1) === 1 && (list[0]?.changes?.[0]?.startsWith("Default") ?? false);
}

function mergeTombstoneMap(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [k, ts] of Object.entries(b ?? {})) {
    if (typeof ts === "number" && ts > (out[k] ?? 0)) out[k] = ts;
  }
  return out;
}

/**
 * Timestamp-aware CRDT set merge for channels, blockedChannels, and newsSources:
 * - If an item was deleted (`deletedAt >= addedAt`), the deletion wins across devices.
 * - If the item was re-added AFTER the deletion (`addedAt > deletedAt`), the re-addition wins
 *   and clears the stale tombstone so other devices never revert a re-follow!
 */
function mergeTimestampedList<T extends { id: string; addedAt?: number }>(
  localItems: T[],
  remoteItems: T[],
  mergedTombs: Record<string, number>,
): T[] {
  const best = new Map<string, T>();
  for (const item of remoteItems) best.set(item.id, item);
  for (const item of localItems) {
    const prev = best.get(item.id);
    if (!prev || (item.addedAt ?? 0) > (prev.addedAt ?? 0)) {
      best.set(item.id, item);
    }
  }
  const out: T[] = [];
  for (const item of best.values()) {
    const deletedAt = mergedTombs[item.id] ?? 0;
    const addedAt = item.addedAt ?? 0;
    if (deletedAt > 0 && deletedAt >= addedAt) {
      // Deletion is newer than (or equal to) addition: item stays deleted.
      continue;
    }
    if (deletedAt > 0 && addedAt > deletedAt) {
      // Re-added after deletion: clear stale tombstone so it stays restored!
      delete mergedTombs[item.id];
    }
    out.push(item);
  }
  return out;
}

function normalizeRemote(raw: Partial<SyncedState> | null | undefined): SyncedState | null {
  if (!raw || typeof raw !== "object") return null;
  const channels: Channel[] = Array.isArray(raw.channels)
    ? raw.channels.filter((c): c is Channel => Boolean(c && typeof c.id === "string" && typeof c.title === "string"))
    : [];
  const blockedChannels: Channel[] = Array.isArray(raw.blockedChannels)
    ? raw.blockedChannels.filter((c): c is Channel => Boolean(c && typeof c.id === "string" && typeof c.title === "string"))
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
  const tombstones: SyncTombstones = {
    channels: raw.tombstones?.channels ?? {},
    blockedChannels: raw.tombstones?.blockedChannels ?? {},
    ratings: raw.tombstones?.ratings ?? {},
    newsSources: raw.tombstones?.newsSources ?? {},
  };
  return {
    channels,
    blockedChannels,
    history,
    progress: raw.progress && typeof raw.progress === "object" ? (raw.progress as Record<string, Progress>) : {},
    ratings: sanitizeRatingsMap(raw.ratings),
    settings: { ...DEFAULTS.settings, ...(raw.settings ?? {}) },
    listened: raw.listened && typeof raw.listened === "object" ? raw.listened : {},
    listenedByDevice: raw.listenedByDevice && typeof raw.listenedByDevice === "object" ? raw.listenedByDevice : {},
    newsSources,
    newsHistory,
    newsRead: raw.newsRead && typeof raw.newsRead === "object" ? raw.newsRead : {},
    tombstones,
    discoverEdition:
      raw.discoverEdition &&
      typeof raw.discoverEdition === "object" &&
      typeof raw.discoverEdition.editionDay === "string" &&
      Array.isArray(raw.discoverEdition.lockedIds)
        ? {
            editionDay: raw.discoverEdition.editionDay,
            lockedIds: raw.discoverEdition.lockedIds.filter((id): id is string => typeof id === "string").slice(0, 30),
          }
        : null,
  };
}

/**
 * Deterministically merge local and remote user states using timestamped additions + tombstones
 * and per-device listening sums so deletions stick, re-follows win, and daily budgets sum accurately.
 */
export function mergeSyncedState(local: SyncedState, remote: SyncedState): { merged: SyncedState; needsPush: boolean } {
  const localTombs = local.tombstones ?? emptyTombstones();
  const remoteTombs = remote.tombstones ?? emptyTombstones();

  const mergedTombs: SyncTombstones = {
    channels: mergeTombstoneMap(localTombs.channels, remoteTombs.channels),
    blockedChannels: mergeTombstoneMap(localTombs.blockedChannels, remoteTombs.blockedChannels),
    ratings: mergeTombstoneMap(localTombs.ratings, remoteTombs.ratings),
    newsSources: mergeTombstoneMap(localTombs.newsSources, remoteTombs.newsSources),
  };

  const channels = mergeTimestampedList(local.channels, remote.channels, mergedTombs.channels);
  const channelIds = new Set(channels.map((c) => c.id));
  const blockedChannels = mergeTimestampedList(
    local.blockedChannels ?? [],
    remote.blockedChannels ?? [],
    mergedTombs.blockedChannels,
  ).filter((c) => !channelIds.has(c.id));
  const newsSources = mergeTimestampedList(local.newsSources, remote.newsSources, mergedTombs.newsSources);

  // Progress: per video id, keep newest `at`, pruned to MAX_PROGRESS_HISTORY.
  const progressMap: Record<string, Progress> = { ...remote.progress };
  for (const [id, entry] of Object.entries(local.progress)) {
    const existing = progressMap[id];
    if (!existing || (entry.at ?? 0) > (existing.at ?? 0)) {
      progressMap[id] = entry;
    }
  }
  const progressEntries = Object.entries(progressMap);
  const progress =
    progressEntries.length > MAX_PROGRESS_HISTORY
      ? Object.fromEntries(progressEntries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, MAX_PROGRESS_HISTORY))
      : progressMap;

  // Video ratings: per video id, newest `ratedAt` vs tombstone `deletedAt`.
  const ratings: Record<string, VideoRating> = {};
  const allRatingIds = new Set([...Object.keys(remote.ratings ?? {}), ...Object.keys(local.ratings ?? {})]);
  for (const id of allRatingIds) {
    const loc = local.ratings?.[id];
    const rem = remote.ratings?.[id];
    const best = !loc ? rem : !rem ? loc : (loc.ratedAt ?? 0) >= (rem.ratedAt ?? 0) ? loc : rem;
    if (!best) continue;
    const deletedAt = mergedTombs.ratings[id] ?? 0;
    if (deletedAt > 0 && deletedAt >= (best.ratedAt ?? 0)) continue;
    ratings[id] = best;
    if (deletedAt > 0 && (best.ratedAt ?? 0) > deletedAt) delete mergedTombs.ratings[id];
  }

  // Per-device listening totals: max per (device, day), then sum across devices for accurate daily budgets!
  const listenedByDevice: Record<string, Record<string, number>> = {};
  for (const source of [remote.listenedByDevice ?? {}, local.listenedByDevice ?? {}]) {
    for (const [devId, dayMap] of Object.entries(source)) {
      const target = listenedByDevice[devId] ?? {};
      for (const [day, sec] of Object.entries(dayMap ?? {})) {
        target[day] = Math.max(target[day] ?? 0, sec ?? 0);
      }
      listenedByDevice[devId] = target;
    }
  }

  const listened: Record<string, number> = { ...remote.listened };
  for (const [day, sec] of Object.entries(local.listened)) {
    listened[day] = Math.max(listened[day] ?? 0, sec ?? 0);
  }
  const deviceDays = new Set<string>();
  for (const dayMap of Object.values(listenedByDevice)) {
    for (const day of Object.keys(dayMap)) deviceDays.add(day);
  }
  for (const day of deviceDays) {
    let sum = 0;
    for (const dayMap of Object.values(listenedByDevice)) sum += dayMap[day] ?? 0;
    listened[day] = Math.max(listened[day] ?? 0, sum);
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

  const settings = { ...local.settings, ...remote.settings };

  // Sync today's locked Discover edition across devices so phone, laptop & tablet share ONE finite daily edition!
  const locEd = local.discoverEdition ?? null;
  const remEd = remote.discoverEdition ?? null;
  let discoverEdition = remEd;
  if (locEd && !remEd) discoverEdition = locEd;
  else if (locEd && remEd) {
    if (locEd.editionDay > remEd.editionDay) discoverEdition = locEd;
    else if (locEd.editionDay === remEd.editionDay && locEd.lockedIds.length > remEd.lockedIds.length) {
      discoverEdition = locEd;
    }
  }

  const merged: SyncedState = {
    channels,
    blockedChannels,
    history,
    progress,
    ratings,
    settings,
    listened,
    listenedByDevice,
    newsSources,
    newsHistory,
    newsRead,
    tombstones: mergedTombs,
    discoverEdition,
  };
  const needsPush = JSON.stringify(merged) !== JSON.stringify(remote);
  return { merged, needsPush };
}

let active = false;
let unsubscribeStore: (() => void) | null = null;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | null = null;
let pendingFullPush = false;
let pendingProgressPush = false;
let knownRevision: number | undefined;

export function startCloudSync(): void {
  if (active) return;
  active = true;
  unsubscribeStore = onLocalSyncedChange((changedKeys) => {
    if (!active) return;
    const onlyProgress = changedKeys.length > 0 && changedKeys.every((k) => PROGRESS_ONLY_KEYS.has(k));
    if (onlyProgress && !pendingFullPush) {
      pendingProgressPush = true;
      clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        pushProgressPatch().catch(() => {});
      }, 4000);
      return;
    }

    pendingFullPush = true;
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
  clearTimeout(progressTimer);
  pushTimer = undefined;
  progressTimer = undefined;
  pendingFullPush = false;
  pendingProgressPush = false;
  knownRevision = undefined;
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
      knownRevision = data.revision ?? 0;
      const local = getSyncedSnapshot();
      const remote = normalizeRemote(data.state);

      if (!remote || data.revision === 0) {
        const hasLocal =
          local.channels.length > 0 ||
          local.newsSources.length > 0 ||
          Object.keys(local.progress).length > 0 ||
          Object.keys(local.ratings).length > 0 ||
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
      if (needsPush || pendingFullPush || pendingProgressPush) {
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

async function uploadSnapshot(snapshot: SyncedState, retried = false): Promise<void> {
  pendingFullPush = false;
  pendingProgressPush = false;
  const res = await apiFetch("/api/me/state", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(typeof knownRevision === "number" ? { "If-Match": String(knownRevision) } : {}),
    },
    body: JSON.stringify({ state: snapshot, expectedRevision: knownRevision }),
  });

  if (res.status === 409 && !retried) {
    const body = (await res.json().catch(() => null)) as {
      current?: { state?: Partial<SyncedState>; revision?: number };
    } | null;
    const remote = normalizeRemote(body?.current?.state);
    if (remote) {
      knownRevision = body?.current?.revision;
      const { merged } = mergeSyncedState(getSyncedSnapshot(), remote);
      applySyncedState(merged);
      return uploadSnapshot(merged, true);
    }
  }

  if (!res.ok) throw new Error(`Could not save changes (${res.status})`);
  const saved = (await res.json().catch(() => null)) as { revision?: number } | null;
  if (typeof saved?.revision === "number") knownRevision = saved.revision;
  setStatus({ state: "synced", lastSyncedAt: Date.now(), error: null });
}

async function pushProgressPatch(): Promise<void> {
  if (!active || !pendingProgressPush) return;
  pendingProgressPush = false;
  clearTimeout(progressTimer);
  progressTimer = undefined;

  const s = getState();
  const recentProgress = Object.entries(s.progress)
    .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    .slice(0, 5);
  const today = dayKey();
  const devId = getDeviceId();
  const devToday = s.listenedByDevice[devId]?.[today];
  const listened = s.listened[today] ? { [today]: s.listened[today] } : {};

  try {
    const res = await apiFetch("/api/me/progress", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        progress: Object.fromEntries(recentProgress),
        listened,
        deviceId: devId,
        ...(typeof devToday === "number" ? { deviceListened: { [today]: devToday } } : {}),
      }),
    });
    if (!res.ok) {
      pendingFullPush = true;
      await pushStateNow();
      return;
    }
    const saved = (await res.json().catch(() => null)) as { revision?: number } | null;
    if (typeof saved?.revision === "number") knownRevision = saved.revision;
    setStatus({ state: "synced", lastSyncedAt: Date.now(), error: null });
  } catch (error) {
    pendingProgressPush = true;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    setStatus({ state: offline ? "offline" : "error", error: offline ? "Offline — will sync when back online" : (error as Error).message });
  }
}

export async function pushStateNow(): Promise<void> {
  if (!active) return;
  clearTimeout(pushTimer);
  pushTimer = undefined;
  setStatus({ state: "syncing", error: null });
  try {
    await uploadSnapshot(getSyncedSnapshot());
  } catch (error) {
    pendingFullPush = true;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    setStatus({ state: offline ? "offline" : "error", error: offline ? "Offline — will sync when back online" : (error as Error).message });
  }
}

export function flushPendingSync(): void {
  if (!active) return;
  if (pendingFullPush) pushStateNow().catch(() => {});
  else if (pendingProgressPush) pushProgressPatch().catch(() => {});
}
