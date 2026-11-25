import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UserRole = "owner" | "user";

export type UserRecord = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  createdAt: number;
  lastSeenAt: number;
};

export type SyncedStatePayload = {
  channels: unknown[];
  history: unknown[];
  progress: Record<string, unknown>;
  settings: Record<string, unknown>;
  listened: Record<string, number>;
  newsSources: unknown[];
  newsHistory: unknown[];
  newsRead: Record<string, number>;
};

export type StoredUserState = {
  state: SyncedStatePayload;
  updatedAt: number;
  revision: number;
};

let db: DatabaseSync | null | undefined;
let dbDisabled = false;

function defaultDbPath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (configured) return configured;
  if (process.env.VERCEL) return ":memory:";
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return ":memory:";
  return process.env.NODE_ENV === "production" ? "/data/longform.db" : "./data/longform.db";
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
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_state (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      channels_json TEXT NOT NULL DEFAULT '[]',
      history_json TEXT NOT NULL DEFAULT '[]',
      progress_json TEXT NOT NULL DEFAULT '{}',
      settings_json TEXT NOT NULL DEFAULT '{}',
      listened_json TEXT NOT NULL DEFAULT '{}',
      news_sources_json TEXT NOT NULL DEFAULT '[]',
      news_history_json TEXT NOT NULL DEFAULT '[]',
      news_read_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS native_auth_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_native_auth_codes_expires ON native_auth_codes(expires_at);
  `);
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

/** True when persistent (or in-memory test) SQLite storage is available. */
export function isDbReady(): boolean {
  if (process.env.VERCEL && !process.env.DATABASE_PATH?.trim()) return false;
  return getDb() !== null;
}

/** Close and reset the database handle (for tests). */
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

  // If a user with the same email already exists under another ID, reuse their canonical ID.
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
         role = CASE WHEN users.role = 'owner' OR excluded.role = 'owner' THEN 'owner' ELSE excluded.role END,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(userId, email, name, avatarUrl, role, now, now);

  return getUserById(userId);
}

export function getUserById(id: string): UserRecord | null {
  const database = getDb();
  if (!database) return null;
  const row = database
    .prepare("SELECT id, email, name, avatar_url, role, created_at, last_seen_at FROM users WHERE id = ?")
    .get(id) as
    | {
        id: string;
        email: string | null;
        name: string | null;
        avatar_url: string | null;
        role: UserRole;
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
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getUserState(userId: string): StoredUserState | null {
  const database = getDb();
  if (!database) return null;
  const row = database
    .prepare(
      `SELECT channels_json, history_json, progress_json, settings_json, listened_json,
              news_sources_json, news_history_json, news_read_json, updated_at, revision
       FROM user_state WHERE user_id = ?`,
    )
    .get(userId) as
    | {
        channels_json: string;
        history_json: string;
        progress_json: string;
        settings_json: string;
        listened_json: string;
        news_sources_json: string;
        news_history_json: string;
        news_read_json: string;
        updated_at: number;
        revision: number;
      }
    | undefined;
  if (!row) return null;
  return {
    state: {
      channels: parseJson<unknown[]>(row.channels_json, []),
      history: parseJson<unknown[]>(row.history_json, []),
      progress: parseJson<Record<string, unknown>>(row.progress_json, {}),
      settings: parseJson<Record<string, unknown>>(row.settings_json, {}),
      listened: parseJson<Record<string, number>>(row.listened_json, {}),
      newsSources: parseJson<unknown[]>(row.news_sources_json, []),
      newsHistory: parseJson<unknown[]>(row.news_history_json, []),
      newsRead: parseJson<Record<string, number>>(row.news_read_json, {}),
    },
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export function saveUserState(userId: string, state: SyncedStatePayload): { updatedAt: number; revision: number } | null {
  const database = getDb();
  if (!database) return null;
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO user_state (
         user_id, channels_json, history_json, progress_json, settings_json,
         listened_json, news_sources_json, news_history_json, news_read_json,
         updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         channels_json = excluded.channels_json,
         history_json = excluded.history_json,
         progress_json = excluded.progress_json,
         settings_json = excluded.settings_json,
         listened_json = excluded.listened_json,
         news_sources_json = excluded.news_sources_json,
         news_history_json = excluded.news_history_json,
         news_read_json = excluded.news_read_json,
         updated_at = excluded.updated_at,
         revision = user_state.revision + 1`,
    )
    .run(
      userId,
      JSON.stringify(state.channels),
      JSON.stringify(state.history),
      JSON.stringify(state.progress),
      JSON.stringify(state.settings),
      JSON.stringify(state.listened),
      JSON.stringify(state.newsSources),
      JSON.stringify(state.newsHistory),
      JSON.stringify(state.newsRead),
      now,
    );

  const meta = database.prepare("SELECT updated_at, revision FROM user_state WHERE user_id = ?").get(userId) as {
    updated_at: number;
    revision: number;
  };
  return { updatedAt: meta.updated_at, revision: meta.revision };
}

// ---------- one-time exchange codes for native mobile OAuth ----------

const NATIVE_CODE_TTL_MS = 2 * 60_000;

export function createNativeAuthCode(user: Pick<UserRecord, "id" | "email" | "name" | "role">): string | null {
  const database = getDb();
  if (!database) return null;
  const now = Date.now();
  database.prepare("DELETE FROM native_auth_codes WHERE expires_at <= ?").run(now);
  const code = randomBytes(32).toString("base64url");
  database
    .prepare("INSERT INTO native_auth_codes (code, user_id, email, name, role, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(code, user.id, user.email, user.name, user.role, now + NATIVE_CODE_TTL_MS);
  return code;
}

export function consumeNativeAuthCode(
  code: string,
): { userId: string; email: string | null; name: string | null; role: UserRole } | null {
  const database = getDb();
  if (!database || !code) return null;
  const now = Date.now();
  const row = database
    .prepare("SELECT user_id, email, name, role, expires_at FROM native_auth_codes WHERE code = ?")
    .get(code) as { user_id: string; email: string | null; name: string | null; role: UserRole; expires_at: number } | undefined;
  database.prepare("DELETE FROM native_auth_codes WHERE code = ? OR expires_at <= ?").run(code, now);
  if (!row || row.expires_at <= now) return null;
  return { userId: row.user_id, email: row.email, name: row.name, role: row.role };
}
