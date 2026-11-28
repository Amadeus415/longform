import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { judgmentKey } from "../src/lib/filter.ts";
import type { ChannelFeed, LlmJudgment, SyncTombstones, Video, VideoFormat } from "../src/lib/types.ts";

export type UserRole = "owner" | "user";

export type UserRecord = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  tokenVersion: number;
  createdAt: number;
  lastSeenAt: number;
};

export type SyncedDiscoverEdition = {
  editionDay: string;
  lockedIds: string[];
};

export type SyncedStatePayload = {
  channels: unknown[];
  blockedChannels?: unknown[];
  history: unknown[];
  progress: Record<string, unknown>;
  ratings?: Record<string, unknown>;
  settings: Record<string, unknown>;
  listened: Record<string, number>;
  listenedByDevice?: Record<string, Record<string, number>>;
  newsSources: unknown[];
  newsHistory: unknown[];
  newsRead: Record<string, number>;
  tombstones?: SyncTombstones;
  discoverEdition?: SyncedDiscoverEdition | null;
};

export type StoredUserState = {
  state: SyncedStatePayload;
  updatedAt: number;
  revision: number;
};

export type CatalogVideo = {
  videoId: string;
  title: string;
  titleHash: string;
  channelId: string;
  channel: string;
  published: string;
  seconds: number | null;
  description?: string;
  chapters?: string[];
  transcript?: string;
  source?: "following" | "discover";
  updatedAt: number;
};

export type CachedChannelFeedRow = {
  channelId: string;
  title: string;
  feed: ChannelFeed;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  subscribers: number;
};

const JUDGMENT_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
const MAX_STORED_PROGRESS = 1_500;
const MAX_CATALOG_ROWS = 100_000;
const MAX_JUDGMENT_ROWS = 100_000;
const MAX_USER_JUDGMENT_ROWS = 50_000;
const DAILY_USAGE_PRUNE_DAYS = 90;
const STALE_CHANNEL_PRUNE_MS = 60 * 24 * 60 * 60_000; // 60 days unused

let db: DatabaseSync | null | undefined;
let dbDisabled = false;

export function titleFingerprint(title: string): string {
  return createHash("sha256").update(title.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 12);
}

function defaultDbPath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (configured) return configured;
  if (process.env.VERCEL) return ":memory:";
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return ":memory:";
  return process.env.NODE_ENV === "production" ? "/data/longform.db" : "./data/longform.db";
}

function cookieEncryptionKey(): Buffer | null {
  const secret =
    process.env.COOKIE_ENCRYPTION_KEY?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    process.env.GOOGLE_CLIENT_SECRET?.trim() ||
    process.env.APP_PASSWORD?.trim() ||
    "";
  if (!secret) return null;
  return createHash("sha256").update(`longform:yt-cookie-enc:v1:${secret}`, "utf8").digest();
}

function sealAesGcm(plaintext: string, key: Buffer, prefix: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function encryptCookie(plaintext: string): string {
  const key = cookieEncryptionKey();
  if (!key) {
    const devKey = createHash("sha256").update("longform:local-dev-cookie-key:v1").digest();
    return sealAesGcm(plaintext, devKey, "enc-dev:");
  }
  return sealAesGcm(plaintext, key, "enc-v1:");
}

function decryptCookie(stored: string): string | null {
  if (!stored) return null;
  if (stored.startsWith("enc-v1:") || stored.startsWith("enc-dev:")) {
    const isDev = stored.startsWith("enc-dev:");
    const rest = stored.slice(isDev ? 8 : 7);
    const [ivB64, tagB64, dataB64] = rest.split(".");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const key = isDev
      ? createHash("sha256").update("longform:local-dev-cookie-key:v1").digest()
      : cookieEncryptionKey();
    if (!key) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(dataB64, "base64url")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      return null;
    }
  }
  return stored;
}

function initSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      name TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_state (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      channels_json TEXT NOT NULL DEFAULT '[]',
      blocked_channels_json TEXT NOT NULL DEFAULT '[]',
      history_json TEXT NOT NULL DEFAULT '[]',
      progress_json TEXT NOT NULL DEFAULT '{}',
      ratings_json TEXT NOT NULL DEFAULT '{}',
      settings_json TEXT NOT NULL DEFAULT '{}',
      listened_json TEXT NOT NULL DEFAULT '{}',
      listened_by_device_json TEXT NOT NULL DEFAULT '{}',
      news_sources_json TEXT NOT NULL DEFAULT '[]',
      news_history_json TEXT NOT NULL DEFAULT '[]',
      news_read_json TEXT NOT NULL DEFAULT '{}',
      tombstones_json TEXT NOT NULL DEFAULT '{}',
      discover_edition_json TEXT NOT NULL DEFAULT 'null',
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS user_progress (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL,
      t REAL NOT NULL,
      d REAL NOT NULL,
      at INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      video_json TEXT NOT NULL,
      PRIMARY KEY (user_id, video_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_progress_user_at ON user_progress(user_id, at DESC);

    CREATE TABLE IF NOT EXISTS native_auth_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      code_challenge TEXT,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_native_auth_codes_expires ON native_auth_codes(expires_at);

    CREATE TABLE IF NOT EXISTS video_judgments (
      cache_key TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      rubric_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      title_hash TEXT,
      score INTEGER NOT NULL,
      brainrot INTEGER NOT NULL,
      depth INTEGER,
      clickbait INTEGER,
      ragebait INTEGER,
      format TEXT,
      category TEXT,
      reason TEXT NOT NULL,
      judged_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_video_judgments_at ON video_judgments(judged_at);

    CREATE TABLE IF NOT EXISTS user_video_judgments (
      cache_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      rubric_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      title_hash TEXT,
      score INTEGER NOT NULL,
      brainrot INTEGER NOT NULL,
      depth INTEGER,
      clickbait INTEGER,
      ragebait INTEGER,
      format TEXT,
      category TEXT,
      reason TEXT NOT NULL,
      judged_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_video_judgments_user ON user_video_judgments(user_id, judged_at);

    CREATE TABLE IF NOT EXISTS channel_feeds (
      channel_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      feed_json TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      fetched_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL DEFAULT 0,
      subscribers INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_channel_feeds_fetched ON channel_feeds(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_channel_feeds_active ON channel_feeds(subscribers DESC, fetched_at ASC);

    CREATE TABLE IF NOT EXISTS channel_subscribers (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_channel_subscribers_user ON channel_subscribers(user_id);

    CREATE TABLE IF NOT EXISTS video_catalog (
      video_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_hash TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      published TEXT NOT NULL DEFAULT '',
      seconds INTEGER,
      description TEXT,
      chapters_json TEXT,
      transcript TEXT,
      source TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_video_catalog_updated ON video_catalog(updated_at);

    CREATE TABLE IF NOT EXISTS daily_usage (
      day TEXT NOT NULL,
      metric TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, metric)
    );

    CREATE TABLE IF NOT EXISTS user_youtube_cookies (
      user_id TEXT PRIMARY KEY,
      cookie TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Idempotent migrations for existing databases.
  const addColIfMissing = (table: string, col: string, def: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  };
  addColIfMissing("users", "token_version", "INTEGER NOT NULL DEFAULT 1");
  addColIfMissing("user_state", "blocked_channels_json", "TEXT NOT NULL DEFAULT '[]'");
  addColIfMissing("user_state", "ratings_json", "TEXT NOT NULL DEFAULT '{}'");
  addColIfMissing("user_state", "tombstones_json", "TEXT NOT NULL DEFAULT '{}'");
  addColIfMissing("user_state", "listened_by_device_json", "TEXT NOT NULL DEFAULT '{}'");
  addColIfMissing("user_state", "discover_edition_json", "TEXT NOT NULL DEFAULT 'null'");
  addColIfMissing("native_auth_codes", "code_challenge", "TEXT");
  addColIfMissing("video_judgments", "depth", "INTEGER");
  addColIfMissing("video_judgments", "clickbait", "INTEGER");
  addColIfMissing("video_judgments", "ragebait", "INTEGER");
  addColIfMissing("video_judgments", "format", "TEXT");
  addColIfMissing("video_judgments", "title_hash", "TEXT");
  addColIfMissing("user_video_judgments", "title_hash", "TEXT");
  addColIfMissing("channel_feeds", "last_accessed_at", "INTEGER NOT NULL DEFAULT 0");
  addColIfMissing("video_catalog", "title_hash", "TEXT NOT NULL DEFAULT ''");

  // One-time backfill of normalized `channel_subscribers` for existing DBs upgrading from blob-only `user_state`.
  const subCount = (database.prepare("SELECT COUNT(*) AS n FROM channel_subscribers").get() as { n: number }).n;
  if (subCount === 0) {
    const existingUsers = database
      .prepare("SELECT user_id, channels_json FROM user_state WHERE channels_json != '[]'")
      .all() as Array<{ user_id: string; channels_json: string }>;
    if (existingUsers.length > 0) {
      const ins = database.prepare("INSERT OR IGNORE INTO channel_subscribers (channel_id, user_id) VALUES (?, ?)");
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const u of existingUsers) {
          const chs = parseJson<Array<{ id?: string }>>(u.channels_json, []);
          for (const ch of chs) {
            if (typeof ch?.id === "string" && ch.id) ins.run(ch.id, u.user_id);
          }
        }
        database.exec(`
          UPDATE channel_feeds
          SET subscribers = (
            SELECT COUNT(*) FROM channel_subscribers cs WHERE cs.channel_id = channel_feeds.channel_id
          )
        `);
        database.exec("COMMIT");
      } catch {
        database.exec("ROLLBACK");
      }
    }
  }
}

function getDb(): DatabaseSync | null {
  if (dbDisabled) return null;
  if (db !== undefined) return db;
  const path = defaultDbPath();
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const instance = new DatabaseSync(path);
    initSchema(instance);
    db = instance;
    return db;
  } catch (error) {
    console.error(`[db] Failed to open SQLite at ${path}: ${(error as Error).message}`);
    dbDisabled = true;
    db = null;
    return null;
  }
}

export function isDbReady(): boolean {
  if (process.env.VERCEL && !process.env.DATABASE_PATH?.trim()) return false;
  return getDb() !== null;
}

export function resetDbForTests(path = ":memory:"): void {
  if (db) {
    try {
      db.close();
    } catch {}
  }
  db = undefined;
  dbDisabled = false;
  process.env.DATABASE_PATH = path;
}

export function upsertUser(input: {
  id: string;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  role?: UserRole;
}): UserRecord | null {
  const database = getDb();
  if (!database) return null;
  const now = Date.now();
  const email = input.email ? input.email.trim().toLowerCase() : null;
  const name = input.name?.trim() || null;
  const avatarUrl = input.avatarUrl?.trim() || null;
  const role: UserRole = input.role ?? "user";

  let userId = input.id;
  if (email) {
    const byEmail = database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    if (byEmail) userId = byEmail.id;
  }

  database
    .prepare(
      `INSERT INTO users (id, email, name, avatar_url, role, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = COALESCE(excluded.email, users.email),
         name = COALESCE(excluded.name, users.name),
         avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
         role = excluded.role,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(userId, email, name, avatarUrl, role, now, now);

  return getUserById(userId);
}

export function getUserById(id: string): UserRecord | null {
  const database = getDb();
  if (!database) return null;
  const row = database
    .prepare("SELECT id, email, name, avatar_url, role, token_version, created_at, last_seen_at FROM users WHERE id = ?")
    .get(id) as
    | {
        id: string;
        email: string | null;
        name: string | null;
        avatar_url: string | null;
        role: UserRole;
        token_version: number;
        created_at: number;
        last_seen_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
    tokenVersion: row.token_version ?? 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Immediately revoke all active session & media tokens for a user (used on logout or admin ban). */
export function bumpUserTokenVersion(userId: string): number {
  const database = getDb();
  if (!database || !userId) return 1;
  database.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(userId);
  const row = database.prepare("SELECT token_version FROM users WHERE id = ?").get(userId) as { token_version: number } | undefined;
  return row?.token_version ?? 1;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const EMPTY_TOMBSTONES: SyncTombstones = {
  channels: {},
  blockedChannels: {},
  ratings: {},
  newsSources: {},
};

function loadUserProgressTable(database: DatabaseSync, userId: string): Record<string, unknown> {
  const rows = database
    .prepare(
      `SELECT video_id, t, d, at, done, video_json
       FROM user_progress WHERE user_id = ?
       ORDER BY at DESC LIMIT ?`,
    )
    .all(userId, MAX_STORED_PROGRESS) as Array<{
    video_id: string;
    t: number;
    d: number;
    at: number;
    done: number;
    video_json: string;
  }>;
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    out[r.video_id] = {
      t: r.t,
      d: r.d,
      at: r.at,
      done: Boolean(r.done),
      video: parseJson<Record<string, unknown>>(r.video_json, { id: r.video_id }),
    };
  }
  return out;
}

export function getUserState(userId: string): StoredUserState | null {
  const database = getDb();
  if (!database) return null;
  const row = database
    .prepare(
      `SELECT channels_json, blocked_channels_json, history_json, progress_json, ratings_json, settings_json,
              listened_json, listened_by_device_json, news_sources_json, news_history_json, news_read_json,
              tombstones_json, discover_edition_json, updated_at, revision
       FROM user_state WHERE user_id = ?`,
    )
    .get(userId) as
    | {
        channels_json: string;
        blocked_channels_json: string;
        history_json: string;
        progress_json: string;
        ratings_json: string;
        settings_json: string;
        listened_json: string;
        listened_by_device_json: string;
        news_sources_json: string;
        news_history_json: string;
        news_read_json: string;
        tombstones_json: string;
        discover_edition_json: string;
        updated_at: number;
        revision: number;
      }
    | undefined;
  if (!row) return null;
  const rawTombstones = parseJson<Partial<SyncTombstones>>(row.tombstones_json, {});
  // Merge legacy JSON progress with dedicated indexed `user_progress` table (newest `at` wins).
  const legacyProgress = parseJson<Record<string, { at?: number }>>(row.progress_json, {});
  const tableProgress = loadUserProgressTable(database, userId) as Record<string, { at?: number }>;
  const progress: Record<string, unknown> = { ...legacyProgress };
  for (const [id, entry] of Object.entries(tableProgress)) {
    const prev = progress[id] as { at?: number } | undefined;
    if (!prev || (entry.at ?? 0) >= (prev.at ?? 0)) {
      progress[id] = entry;
    }
  }

  return {
    state: {
      channels: parseJson<unknown[]>(row.channels_json, []),
      blockedChannels: parseJson<unknown[]>(row.blocked_channels_json, []),
      history: parseJson<unknown[]>(row.history_json, []),
      progress,
      ratings: parseJson<Record<string, unknown>>(row.ratings_json, {}),
      settings: parseJson<Record<string, unknown>>(row.settings_json, {}),
      listened: parseJson<Record<string, number>>(row.listened_json, {}),
      listenedByDevice: parseJson<Record<string, Record<string, number>>>(row.listened_by_device_json, {}),
      newsSources: parseJson<unknown[]>(row.news_sources_json, []),
      newsHistory: parseJson<unknown[]>(row.news_history_json, []),
      newsRead: parseJson<Record<string, number>>(row.news_read_json, {}),
      tombstones: {
        channels: rawTombstones.channels ?? {},
        blockedChannels: rawTombstones.blockedChannels ?? {},
        ratings: rawTombstones.ratings ?? {},
        newsSources: rawTombstones.newsSources ?? {},
      },
      discoverEdition: parseJson<SyncedDiscoverEdition | null>(row.discover_edition_json, null),
    },
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export type SaveUserStateResult =
  | { ok: true; updatedAt: number; revision: number }
  | { ok: false; conflict: true; current: StoredUserState }
  | { ok: false; conflict: false };

export function saveUserState(
  userId: string,
  state: SyncedStatePayload,
  expectedRevision?: number,
): SaveUserStateResult {
  const database = getDb();
  if (!database) return { ok: false, conflict: false };
  const now = Date.now();

  if (typeof expectedRevision === "number" && Number.isFinite(expectedRevision)) {
    const existing = getUserState(userId);
    const currentRev = existing?.revision ?? 0;
    if (currentRev !== expectedRevision && existing) {
      return { ok: false, conflict: true, current: existing };
    }
  }

  // Upsert progress entries into the indexed `user_progress` table so progress patches stay O(1).
  const upsertProg = database.prepare(
    `INSERT INTO user_progress (user_id, video_id, t, d, at, done, video_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, video_id) DO UPDATE SET
       t = CASE WHEN excluded.at >= user_progress.at THEN excluded.t ELSE user_progress.t END,
       d = CASE WHEN excluded.at >= user_progress.at THEN excluded.d ELSE user_progress.d END,
       at = MAX(user_progress.at, excluded.at),
       done = CASE WHEN excluded.at >= user_progress.at THEN excluded.done ELSE user_progress.done END,
       video_json = CASE WHEN excluded.at >= user_progress.at THEN excluded.video_json ELSE user_progress.video_json END`,
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO user_state (
           user_id, channels_json, blocked_channels_json, history_json, progress_json, ratings_json, settings_json,
           listened_json, listened_by_device_json, news_sources_json, news_history_json, news_read_json, tombstones_json,
           discover_edition_json, updated_at, revision
         ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(user_id) DO UPDATE SET
           channels_json = excluded.channels_json,
           blocked_channels_json = excluded.blocked_channels_json,
           history_json = excluded.history_json,
           progress_json = '{}',
           ratings_json = excluded.ratings_json,
           settings_json = excluded.settings_json,
           listened_json = excluded.listened_json,
           listened_by_device_json = excluded.listened_by_device_json,
           news_sources_json = excluded.news_sources_json,
           news_history_json = excluded.news_history_json,
           news_read_json = excluded.news_read_json,
           tombstones_json = excluded.tombstones_json,
           discover_edition_json = excluded.discover_edition_json,
           updated_at = excluded.updated_at,
           revision = user_state.revision + 1`,
      )
      .run(
        userId,
        JSON.stringify(state.channels),
        JSON.stringify(state.blockedChannels ?? []),
        JSON.stringify(state.history),
        JSON.stringify(state.ratings ?? {}),
        JSON.stringify(state.settings),
        JSON.stringify(state.listened),
        JSON.stringify(state.listenedByDevice ?? {}),
        JSON.stringify(state.newsSources),
        JSON.stringify(state.newsHistory),
        JSON.stringify(state.newsRead),
        JSON.stringify(state.tombstones ?? EMPTY_TOMBSTONES),
        JSON.stringify(state.discoverEdition ?? null),
        now,
      );

    for (const [vid, raw] of Object.entries(state.progress ?? {})) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as { t?: number; d?: number; at?: number; done?: boolean; video?: unknown };
      if (typeof p.d !== "number" || !Number.isFinite(p.d) || p.d <= 0) continue;
      upsertProg.run(
        userId,
        vid,
        typeof p.t === "number" && Number.isFinite(p.t) ? Math.max(0, p.t) : 0,
        p.d,
        typeof p.at === "number" && Number.isFinite(p.at) ? Math.round(p.at) : now,
        p.done ? 1 : 0,
        JSON.stringify(p.video && typeof p.video === "object" ? p.video : { id: vid }),
      );
    }

    // Prune excess rows beyond MAX_STORED_PROGRESS.
    database
      .prepare(
        `DELETE FROM user_progress
         WHERE user_id = ? AND video_id NOT IN (
           SELECT video_id FROM user_progress WHERE user_id = ? ORDER BY at DESC LIMIT ?
         )`,
      )
      .run(userId, userId, MAX_STORED_PROGRESS);

    // Incrementally sync normalized `channel_subscribers` + `channel_feeds.subscribers` in O(changed channels),
    // eliminating the O(users × channels) full-table scan during background crawls!
    const prevRows = database
      .prepare("SELECT channel_id FROM channel_subscribers WHERE user_id = ?")
      .all(userId) as Array<{ channel_id: string }>;
    const prevIds = new Set(prevRows.map((r) => r.channel_id));
    const nextIds = new Set<string>();
    for (const rawCh of state.channels ?? []) {
      const id = (rawCh as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id) nextIds.add(id);
    }

    const removed: string[] = [];
    for (const id of prevIds) {
      if (!nextIds.has(id)) removed.push(id);
    }
    const added: string[] = [];
    for (const id of nextIds) {
      if (!prevIds.has(id)) added.push(id);
    }

    if (removed.length > 0) {
      const delSub = database.prepare("DELETE FROM channel_subscribers WHERE user_id = ? AND channel_id = ?");
      for (const id of removed) delSub.run(userId, id);
    }
    if (added.length > 0) {
      const insSub = database.prepare("INSERT OR IGNORE INTO channel_subscribers (channel_id, user_id) VALUES (?, ?)");
      for (const id of added) insSub.run(id, userId);
    }
    if (removed.length > 0 || added.length > 0) {
      const updateSubCount = database.prepare(
        `UPDATE channel_feeds
         SET subscribers = (SELECT COUNT(*) FROM channel_subscribers WHERE channel_id = ?)
         WHERE channel_id = ?`,
      );
      for (const id of removed) updateSubCount.run(id, id);
      for (const id of added) updateSubCount.run(id, id);
    }

    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }

  const meta = database.prepare("SELECT updated_at, revision FROM user_state WHERE user_id = ?").get(userId) as {
    updated_at: number;
    revision: number;
  };
  return { ok: true, updatedAt: meta.updated_at, revision: meta.revision };
}

/**
 * O(1) indexed progress + per-device listened patch (never parses/rewrites a full progress blob!).
 */
export function patchUserProgress(
  userId: string,
  patch: {
    progress?: Record<string, { t: number; d: number; at: number; done?: boolean; video: Record<string, unknown> }>;
    listened?: Record<string, number>;
    deviceId?: string;
    deviceListened?: Record<string, number>;
  },
): { updatedAt: number; revision: number } | null {
  const database = getDb();
  if (!database) return null;
  const now = Date.now();

  database.exec("BEGIN IMMEDIATE");
  try {
    // Ensure user_state row exists.
    database
      .prepare(
        `INSERT INTO user_state (user_id, updated_at, revision) VALUES (?, ?, 0)
         ON CONFLICT(user_id) DO NOTHING`,
      )
      .run(userId, now);

    if (patch.progress) {
      const stmt = database.prepare(
        `INSERT INTO user_progress (user_id, video_id, t, d, at, done, video_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, video_id) DO UPDATE SET
           t = CASE WHEN excluded.at >= user_progress.at THEN excluded.t ELSE user_progress.t END,
           d = CASE WHEN excluded.at >= user_progress.at THEN excluded.d ELSE user_progress.d END,
           at = MAX(user_progress.at, excluded.at),
           done = CASE WHEN excluded.at >= user_progress.at THEN excluded.done ELSE user_progress.done END,
           video_json = CASE WHEN excluded.at >= user_progress.at THEN excluded.video_json ELSE user_progress.video_json END`,
      );
      for (const [vid, entry] of Object.entries(patch.progress)) {
        stmt.run(userId, vid, entry.t, entry.d, entry.at, entry.done ? 1 : 0, JSON.stringify(entry.video));
      }
      database
        .prepare(
          `DELETE FROM user_progress
           WHERE user_id = ? AND video_id NOT IN (
             SELECT video_id FROM user_progress WHERE user_id = ? ORDER BY at DESC LIMIT ?
           )`,
        )
        .run(userId, userId, MAX_STORED_PROGRESS);
    }

    const row = database
      .prepare("SELECT listened_json, listened_by_device_json FROM user_state WHERE user_id = ?")
      .get(userId) as { listened_json: string; listened_by_device_json: string };
    const listened = parseJson<Record<string, number>>(row.listened_json, {});
    const byDevice = parseJson<Record<string, Record<string, number>>>(row.listened_by_device_json, {});

    if (patch.deviceId && patch.deviceListened) {
      const devMap = byDevice[patch.deviceId] ?? {};
      for (const [day, sec] of Object.entries(patch.deviceListened)) {
        if (typeof sec === "number" && Number.isFinite(sec) && sec >= 0) {
          devMap[day] = Math.max(devMap[day] ?? 0, sec);
        }
      }
      byDevice[patch.deviceId] = devMap;
      // Recompute daily totals by summing across all devices (fixes cross-device undercounting!).
      const allDays = new Set<string>(Object.keys(listened));
      for (const dMap of Object.values(byDevice)) {
        for (const day of Object.keys(dMap)) allDays.add(day);
      }
      for (const day of allDays) {
        let sum = 0;
        for (const dMap of Object.values(byDevice)) sum += dMap[day] ?? 0;
        listened[day] = Math.max(listened[day] ?? 0, sum);
      }
    } else if (patch.listened) {
      for (const [day, sec] of Object.entries(patch.listened)) {
        if (typeof sec === "number" && Number.isFinite(sec) && sec >= 0) {
          listened[day] = Math.max(listened[day] ?? 0, sec);
        }
      }
    }

    database
      .prepare(
        `UPDATE user_state
         SET listened_json = ?, listened_by_device_json = ?, updated_at = ?, revision = revision + 1
         WHERE user_id = ?`,
      )
      .run(JSON.stringify(listened), JSON.stringify(byDevice), now, userId);

    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }

  const meta = database.prepare("SELECT updated_at, revision FROM user_state WHERE user_id = ?").get(userId) as {
    updated_at: number;
    revision: number;
  };
  return { updatedAt: meta.updated_at, revision: meta.revision };
}

// ---------- one-time exchange codes for native mobile OAuth ----------

const NATIVE_CODE_TTL_MS = 2 * 60_000;

export function createNativeAuthCode(
  user: Pick<UserRecord, "id" | "email" | "name" | "role">,
  codeChallenge?: string | null,
): string | null {
  const database = getDb();
  if (!database) return null;
  const now = Date.now();
  database.prepare("DELETE FROM native_auth_codes WHERE expires_at <= ?").run(now);
  const code = randomBytes(32).toString("base64url");
  database
    .prepare("INSERT INTO native_auth_codes (code, user_id, email, name, role, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(code, user.id, user.email, user.name, user.role, codeChallenge || null, now + NATIVE_CODE_TTL_MS);
  return code;
}

export function consumeNativeAuthCode(
  code: string,
): { userId: string; email: string | null; name: string | null; role: UserRole; codeChallenge: string | null } | null {
  const database = getDb();
  if (!database || !code) return null;
  const now = Date.now();
  const row = database
    .prepare("SELECT user_id, email, name, role, code_challenge, expires_at FROM native_auth_codes WHERE code = ?")
    .get(code) as
    | { user_id: string; email: string | null; name: string | null; role: UserRole; code_challenge: string | null; expires_at: number }
    | undefined;
  database.prepare("DELETE FROM native_auth_codes WHERE code = ? OR expires_at <= ?").run(code, now);
  if (!row || row.expires_at <= now) return null;
  return { userId: row.user_id, email: row.email, name: row.name, role: row.role, codeChallenge: row.code_challenge ?? null };
}

// ---------- cached LLM video judgments (shared canonical + isolated per-user custom, with TTL & title-hash freshness) ----------

type JudgmentRow = {
  cache_key: string;
  video_id: string;
  rubric_hash: string;
  model: string;
  title_hash: string | null;
  score: number;
  brainrot: number;
  depth: number | null;
  clickbait: number | null;
  ragebait: number | null;
  format: string | null;
  category: string | null;
  reason: string;
  judged_at: number;
};

function rowToJudgment(r: JudgmentRow): LlmJudgment {
  return {
    videoId: r.video_id,
    rubricHash: r.rubric_hash,
    model: r.model,
    score: r.score,
    brainrot: Boolean(r.brainrot),
    ...(typeof r.depth === "number" ? { depth: r.depth } : {}),
    ...(typeof r.clickbait === "number" ? { clickbait: r.clickbait } : {}),
    ...(typeof r.ragebait === "number" ? { ragebait: r.ragebait } : {}),
    ...(r.format ? { format: r.format as VideoFormat } : {}),
    ...(r.category ? { category: r.category } : {}),
    reason: r.reason,
    judgedAt: r.judged_at,
  };
}

export function getCachedJudgments(
  cacheKeys: string[],
  expectedTitleHashes?: Readonly<Record<string, string>>,
): Record<string, LlmJudgment> {
  const database = getDb();
  if (!database || !cacheKeys.length) return {};
  const unique = [...new Set(cacheKeys)];
  const placeholders = unique.map(() => "?").join(", ");
  const minJudgedAt = Date.now() - JUDGMENT_TTL_MS;
  const rows = database
    .prepare(
      `SELECT cache_key, video_id, rubric_hash, model, title_hash, score, brainrot, depth, clickbait, ragebait, format, category, reason, judged_at
       FROM video_judgments WHERE cache_key IN (${placeholders}) AND judged_at >= ?`,
    )
    .all(...unique, minJudgedAt) as JudgmentRow[];

  const out: Record<string, LlmJudgment> = {};
  for (const r of rows) {
    // Invalidate if creator A/B-changed the video's title after it was scored!
    const expectedHash = expectedTitleHashes?.[r.video_id];
    if (expectedHash && r.title_hash && r.title_hash !== expectedHash) continue;
    out[r.cache_key] = rowToJudgment(r);
  }
  return out;
}

export function saveCachedJudgments(items: LlmJudgment[], titleHashes?: Readonly<Record<string, string>>): void {
  const database = getDb();
  if (!database || !items.length) return;
  const stmt = database.prepare(
    `INSERT INTO video_judgments (cache_key, video_id, rubric_hash, model, title_hash, score, brainrot, depth, clickbait, ragebait, format, category, reason, judged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       title_hash = COALESCE(excluded.title_hash, video_judgments.title_hash),
       score = excluded.score,
       brainrot = excluded.brainrot,
       depth = excluded.depth,
       clickbait = excluded.clickbait,
       ragebait = excluded.ragebait,
       format = excluded.format,
       category = excluded.category,
       reason = excluded.reason,
       judged_at = excluded.judged_at`,
  );
  for (const item of items) {
    const key = `${judgmentKey(item.videoId, item.rubricHash)}:${item.model}`;
    stmt.run(
      key,
      item.videoId,
      item.rubricHash,
      item.model,
      titleHashes?.[item.videoId] ?? null,
      item.score,
      item.brainrot ? 1 : 0,
      item.depth ?? null,
      item.clickbait ?? null,
      item.ragebait ?? null,
      item.format ?? null,
      item.category ?? null,
      item.reason,
      item.judgedAt,
    );
  }
}

export function getUserCachedJudgments(
  userId: string,
  cacheKeys: string[],
  expectedTitleHashes?: Readonly<Record<string, string>>,
): Record<string, LlmJudgment> {
  const database = getDb();
  if (!database || !userId || !cacheKeys.length) return {};
  const unique = [...new Set(cacheKeys)];
  const placeholders = unique.map(() => "?").join(", ");
  const minJudgedAt = Date.now() - JUDGMENT_TTL_MS;
  const rows = database
    .prepare(
      `SELECT cache_key, video_id, rubric_hash, model, title_hash, score, brainrot, depth, clickbait, ragebait, format, category, reason, judged_at
       FROM user_video_judgments WHERE user_id = ? AND cache_key IN (${placeholders}) AND judged_at >= ?`,
    )
    .all(userId, ...unique, minJudgedAt) as JudgmentRow[];

  const out: Record<string, LlmJudgment> = {};
  for (const r of rows) {
    const expectedHash = expectedTitleHashes?.[r.video_id];
    if (expectedHash && r.title_hash && r.title_hash !== expectedHash) continue;
    out[r.cache_key] = rowToJudgment(r);
  }
  return out;
}

export function saveUserCachedJudgments(
  userId: string,
  items: LlmJudgment[],
  titleHashes?: Readonly<Record<string, string>>,
): void {
  const database = getDb();
  if (!database || !userId || !items.length) return;
  const stmt = database.prepare(
    `INSERT INTO user_video_judgments (cache_key, user_id, video_id, rubric_hash, model, title_hash, score, brainrot, depth, clickbait, ragebait, format, category, reason, judged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       title_hash = COALESCE(excluded.title_hash, user_video_judgments.title_hash),
       score = excluded.score,
       brainrot = excluded.brainrot,
       depth = excluded.depth,
       clickbait = excluded.clickbait,
       ragebait = excluded.ragebait,
       format = excluded.format,
       category = excluded.category,
       reason = excluded.reason,
       judged_at = excluded.judged_at`,
  );
  for (const item of items) {
    const key = `${userId}:${judgmentKey(item.videoId, item.rubricHash)}:${item.model}`;
    stmt.run(
      key,
      userId,
      item.videoId,
      item.rubricHash,
      item.model,
      titleHashes?.[item.videoId] ?? null,
      item.score,
      item.brainrot ? 1 : 0,
      item.depth ?? null,
      item.clickbait ?? null,
      item.ragebait ?? null,
      item.format ?? null,
      item.category ?? null,
      item.reason,
      item.judgedAt,
    );
  }
}

// ---------- persistent channel feeds & trusted server-owned video catalog ----------

export function getStoredChannelFeed(
  channelId: string,
  options?: { touchAccess?: boolean },
): CachedChannelFeedRow | null {
  const database = getDb();
  if (!database) return null;
  const row = database
    .prepare("SELECT channel_id, title, feed_json, etag, last_modified, fetched_at, subscribers FROM channel_feeds WHERE channel_id = ?")
    .get(channelId) as
    | {
        channel_id: string;
        title: string;
        feed_json: string;
        etag: string | null;
        last_modified: string | null;
        fetched_at: number;
        subscribers: number;
      }
    | undefined;
  if (!row) return null;
  const feed = parseJson<ChannelFeed | null>(row.feed_json, null);
  if (!feed) return null;
  // Touch last_accessed_at ONLY on interactive reads (never from background crawler so abandoned channels prune!).
  if (options?.touchAccess !== false) {
    database.prepare("UPDATE channel_feeds SET last_accessed_at = ? WHERE channel_id = ?").run(Date.now(), channelId);
  }
  return {
    channelId: row.channel_id,
    title: row.title,
    feed,
    etag: row.etag,
    lastModified: row.last_modified,
    fetchedAt: row.fetched_at,
    subscribers: row.subscribers,
  };
}

export function saveStoredChannelFeed(
  feed: ChannelFeed,
  meta?: { etag?: string | null; lastModified?: string | null; touchAccess?: boolean },
): void {
  const database = getDb();
  if (!database) return;
  const now = Date.now();
  const accessTs = meta?.touchAccess === false ? 0 : now;
  const subRow = database
    .prepare("SELECT COUNT(*) AS n FROM channel_subscribers WHERE channel_id = ?")
    .get(feed.id) as { n: number };
  const subs = subRow?.n ?? 0;
  database
    .prepare(
      `INSERT INTO channel_feeds (channel_id, title, feed_json, etag, last_modified, fetched_at, last_accessed_at, subscribers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         title = excluded.title,
         feed_json = excluded.feed_json,
         etag = COALESCE(excluded.etag, channel_feeds.etag),
         last_modified = COALESCE(excluded.last_modified, channel_feeds.last_modified),
         fetched_at = excluded.fetched_at,
         subscribers = excluded.subscribers,
         last_accessed_at = CASE
           WHEN excluded.last_accessed_at > 0 THEN MAX(channel_feeds.last_accessed_at, excluded.last_accessed_at)
           ELSE channel_feeds.last_accessed_at
         END`,
    )
    .run(feed.id, feed.title, JSON.stringify(feed), meta?.etag ?? null, meta?.lastModified ?? null, feed.fetchedAt, accessTs, subs);
}

/**
 * Two-lane fair selection of stalest active channels in O(log N):
 * - Lane 1 (50% of slots): highest-subscriber stale channels (keeps popular feeds fresh for most users).
 * - Lane 2 (50% of slots): globally stalest subscribed/active channels by `fetched_at ASC` (prevents popular
 *   channels from starving the long tail in 5,000+ channel pools!).
 */
export function refreshChannelPopularityAndListStale(olderThanMs: number, limit = 25): { stale: string[]; totalActive: number } {
  const database = getDb();
  if (!database) return { stale: [], totalActive: 0 };

  const cutoff = Date.now() - olderThanMs;
  const recentCutoff = Date.now() - 14 * 24 * 60 * 60_000;
  const totalRow = database
    .prepare("SELECT COUNT(*) as n FROM channel_feeds WHERE subscribers > 0 OR last_accessed_at >= ?")
    .get(recentCutoff) as { n: number };

  const popularLimit = Math.ceil(limit / 2);
  const popularRows = database
    .prepare(
      `SELECT channel_id FROM channel_feeds
       WHERE fetched_at < ? AND (subscribers > 0 OR last_accessed_at >= ?)
       ORDER BY subscribers DESC, fetched_at ASC
       LIMIT ?`,
    )
    .all(cutoff, recentCutoff, popularLimit) as Array<{ channel_id: string }>;

  const picked = new Set(popularRows.map((r) => r.channel_id));
  const fairLimit = limit - picked.size;
  if (fairLimit > 0) {
    const oldestRows = database
      .prepare(
        `SELECT channel_id FROM channel_feeds
         WHERE fetched_at < ? AND (subscribers > 0 OR last_accessed_at >= ?)
         ORDER BY fetched_at ASC
         LIMIT ?`,
      )
      .all(cutoff, recentCutoff, limit) as Array<{ channel_id: string }>;
    for (const r of oldestRows) {
      if (picked.size >= limit) break;
      picked.add(r.channel_id);
    }
  }

  return { stale: [...picked], totalActive: totalRow?.n ?? 0 };
}

/** Periodic storage hygiene so SQLite tables stay bounded at 1,000s of users. */
export function pruneOldCacheRows(now = Date.now()): void {
  const database = getDb();
  if (!database) return;
  try {
    // Reconcile any orphaned subscriber counts (e.g. after user deletion) before pruning.
    database.exec(`
      UPDATE channel_feeds
      SET subscribers = (
        SELECT COUNT(*) FROM channel_subscribers cs WHERE cs.channel_id = channel_feeds.channel_id
      )
      WHERE subscribers > 0
        AND NOT EXISTS (SELECT 1 FROM channel_subscribers cs WHERE cs.channel_id = channel_feeds.channel_id)
    `);
    database
      .prepare("DELETE FROM channel_feeds WHERE subscribers = 0 AND last_accessed_at < ?")
      .run(now - STALE_CHANNEL_PRUNE_MS);
    database.prepare("DELETE FROM video_judgments WHERE judged_at < ?").run(now - JUDGMENT_TTL_MS * 2);
    database.prepare("DELETE FROM user_video_judgments WHERE judged_at < ?").run(now - JUDGMENT_TTL_MS * 2);
    const oldUsageDay = new Date(now - DAILY_USAGE_PRUNE_DAYS * 86_400_000).toISOString().slice(0, 10);
    database.prepare("DELETE FROM daily_usage WHERE day < ?").run(oldUsageDay);
    database
      .prepare(
        `DELETE FROM video_catalog WHERE video_id NOT IN (
           SELECT video_id FROM video_catalog ORDER BY updated_at DESC LIMIT ?
         )`,
      )
      .run(MAX_CATALOG_ROWS);
    database
      .prepare(
        `DELETE FROM video_judgments WHERE cache_key NOT IN (
           SELECT cache_key FROM video_judgments ORDER BY judged_at DESC LIMIT ?
         )`,
      )
      .run(MAX_JUDGMENT_ROWS);
    database
      .prepare(
        `DELETE FROM user_video_judgments WHERE cache_key NOT IN (
           SELECT cache_key FROM user_video_judgments ORDER BY judged_at DESC LIMIT ?
         )`,
      )
      .run(MAX_USER_JUDGMENT_ROWS);
  } catch {}
}

/** Keep quiet channels' catalog rows fresh on 304 Not Modified so they are never evicted by catalog pruning. */
export function touchCatalogVideos(videoIds: string[]): void {
  const database = getDb();
  if (!database || !videoIds.length) return;
  const unique = [...new Set(videoIds)].slice(0, 100);
  const placeholders = unique.map(() => "?").join(", ");
  database
    .prepare(`UPDATE video_catalog SET updated_at = ? WHERE video_id IN (${placeholders})`)
    .run(Date.now(), ...unique);
}

export function upsertCatalogVideos(videos: Video[]): void {
  const database = getDb();
  if (!database || !videos.length) return;
  const now = Date.now();
  const stmt = database.prepare(
    `INSERT INTO video_catalog (video_id, title, title_hash, channel_id, channel, published, seconds, description, chapters_json, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE video_catalog.title END,
       title_hash = CASE WHEN excluded.title != '' THEN excluded.title_hash ELSE video_catalog.title_hash END,
       channel_id = CASE WHEN excluded.channel_id != '' THEN excluded.channel_id ELSE video_catalog.channel_id END,
       channel = CASE WHEN excluded.channel != '' THEN excluded.channel ELSE video_catalog.channel END,
       published = CASE WHEN excluded.published != '' THEN excluded.published ELSE video_catalog.published END,
       seconds = COALESCE(excluded.seconds, video_catalog.seconds),
       description = COALESCE(excluded.description, video_catalog.description),
       chapters_json = COALESCE(excluded.chapters_json, video_catalog.chapters_json),
       source = CASE WHEN video_catalog.source = 'following' OR excluded.source = 'following' THEN 'following' ELSE COALESCE(excluded.source, video_catalog.source) END,
       updated_at = excluded.updated_at`,
  );
  for (const v of videos) {
    if (!v.id || !v.title) continue;
    const chapters = v.chapters?.length ? JSON.stringify(v.chapters.map(([, title]) => title)) : null;
    stmt.run(
      v.id,
      v.title.slice(0, 220),
      titleFingerprint(v.title),
      v.channelId || "",
      v.channel || "",
      v.published || "",
      typeof v.seconds === "number" ? v.seconds : null,
      v.description ? v.description.slice(0, 400) : null,
      chapters,
      v.source ?? null,
      now,
    );
  }
}

export function updateCatalogTranscript(videoId: string, transcript: string, description?: string): void {
  const database = getDb();
  if (!database || !videoId) return;
  database
    .prepare(
      `UPDATE video_catalog
       SET transcript = COALESCE(?, transcript),
           description = COALESCE(?, description),
           updated_at = ?
       WHERE video_id = ?`,
    )
    .run(transcript ? transcript.slice(0, 1600) : null, description ? description.slice(0, 400) : null, Date.now(), videoId);
}

export function getCatalogVideos(videoIds: string[]): Record<string, CatalogVideo> {
  const database = getDb();
  if (!database || !videoIds.length) return {};
  const unique = [...new Set(videoIds)];
  const placeholders = unique.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT video_id, title, title_hash, channel_id, channel, published, seconds, description, chapters_json, transcript, source, updated_at
       FROM video_catalog WHERE video_id IN (${placeholders})`,
    )
    .all(...unique) as Array<{
    video_id: string;
    title: string;
    title_hash: string;
    channel_id: string;
    channel: string;
    published: string;
    seconds: number | null;
    description: string | null;
    chapters_json: string | null;
    transcript: string | null;
    source: string | null;
    updated_at: number;
  }>;

  const out: Record<string, CatalogVideo> = {};
  for (const r of rows) {
    out[r.video_id] = {
      videoId: r.video_id,
      title: r.title,
      titleHash: r.title_hash || titleFingerprint(r.title),
      channelId: r.channel_id,
      channel: r.channel,
      published: r.published,
      seconds: r.seconds,
      ...(r.description ? { description: r.description } : {}),
      ...(r.chapters_json ? { chapters: parseJson<string[]>(r.chapters_json, []) } : {}),
      ...(r.transcript ? { transcript: r.transcript } : {}),
      ...(r.source === "discover" || r.source === "following" ? { source: r.source } : {}),
      updatedAt: r.updated_at,
    };
  }
  return out;
}

// ---------- atomic daily usage reservation & refund (prevents concurrent budget overspend!) ----------

function utcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function getDailyUsage(metric: string, now = Date.now()): number {
  const database = getDb();
  if (!database) return 0;
  const row = database
    .prepare("SELECT count FROM daily_usage WHERE day = ? AND metric = ?")
    .get(utcDayKey(now), metric) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * Atomically reserve up to `requested` units under `limit` inside an IMMEDIATE SQLite transaction.
 * Guarantees concurrent requests NEVER overshoot the budget.
 */
export function reserveDailyUsage(
  metric: string,
  requested: number,
  limit: number,
  now = Date.now(),
): { granted: number; remaining: number } {
  const database = getDb();
  if (!database || requested <= 0 || limit <= 0) {
    return { granted: 0, remaining: Math.max(0, limit - getDailyUsage(metric, now)) };
  }
  const day = utcDayKey(now);
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database
      .prepare("SELECT count FROM daily_usage WHERE day = ? AND metric = ?")
      .get(day, metric) as { count: number } | undefined;
    const current = row?.count ?? 0;
    const available = Math.max(0, limit - current);
    const granted = Math.min(Math.round(requested), available);
    if (granted > 0) {
      database
        .prepare(
          `INSERT INTO daily_usage (day, metric, count) VALUES (?, ?, ?)
           ON CONFLICT(day, metric) DO UPDATE SET count = daily_usage.count + excluded.count`,
        )
        .run(day, metric, granted);
    }
    database.exec("COMMIT");
    return { granted, remaining: Math.max(0, limit - (current + granted)) };
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

export function refundDailyUsage(metric: string, amount: number, now = Date.now()): void {
  const database = getDb();
  if (!database || amount <= 0) return;
  const day = utcDayKey(now);
  database
    .prepare("UPDATE daily_usage SET count = MAX(0, count - ?) WHERE day = ? AND metric = ?")
    .run(Math.round(amount), day, metric);
}

// ---------- optional per-user YouTube cookie (AES-256-GCM encrypted at rest, never returned) ----------

export function getUserYoutubeCookie(userId: string): string | null {
  const database = getDb();
  if (!database || !userId) return null;
  const row = database.prepare("SELECT cookie FROM user_youtube_cookies WHERE user_id = ?").get(userId) as
    | { cookie: string }
    | undefined;
  if (!row?.cookie) return null;
  return decryptCookie(row.cookie);
}

export function setUserYoutubeCookie(userId: string, cookie: string | null): boolean {
  const database = getDb();
  if (!database || !userId) return false;
  if (!cookie) {
    database.prepare("DELETE FROM user_youtube_cookies WHERE user_id = ?").run(userId);
    return true;
  }
  const encrypted = encryptCookie(cookie);
  database
    .prepare(
      `INSERT INTO user_youtube_cookies (user_id, cookie, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         cookie = excluded.cookie,
         updated_at = excluded.updated_at`,
    )
    .run(userId, encrypted, Date.now());
  return true;
}
