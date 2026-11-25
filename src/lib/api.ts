import { isNative, prefGet, prefRemove, prefSet } from "./native";

const SERVER_URL_KEY = "longform.serverUrl";
const AUTH_TOKEN_KEY = "longform.authToken";

const BUILD_DEFAULT_API = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? "")
  .trim()
  .replace(/\/+$/, "");

let serverUrl = "";
let authToken: string | null = null;
let mediaToken: string | null = null;
let initialized = false;

const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Normalize user-entered server URLs (e.g., "longform.fly.dev" -> "https://longform.fly.dev"). */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(trimmed) || /\.local(?::\d+)?$/i.test(trimmed);
  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

export async function initApi(): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (isNative()) {
    const savedServer = await prefGet(SERVER_URL_KEY);
    serverUrl = normalizeServerUrl(savedServer || BUILD_DEFAULT_API);
    authToken = await prefGet(AUTH_TOKEN_KEY);
  } else {
    serverUrl = BUILD_DEFAULT_API;
  }
}

export function getServerUrl(): string {
  return serverUrl;
}

export function needsServerConfig(): boolean {
  return isNative() && !serverUrl;
}

export async function setServerUrl(next: string): Promise<string> {
  const normalized = normalizeServerUrl(next);
  serverUrl = normalized;
  if (normalized) await prefSet(SERVER_URL_KEY, normalized);
  else await prefRemove(SERVER_URL_KEY);
  return normalized;
}

export async function setAuthTokens(tokens: { token?: string | null; mediaToken?: string | null }): Promise<void> {
  if (tokens.token !== undefined) {
    authToken = tokens.token;
    if (tokens.token) await prefSet(AUTH_TOKEN_KEY, tokens.token);
    else await prefRemove(AUTH_TOKEN_KEY);
  }
  if (tokens.mediaToken !== undefined) {
    mediaToken = tokens.mediaToken;
  }
}

export async function clearAuthTokens(): Promise<void> {
  authToken = null;
  mediaToken = null;
  await prefRemove(AUTH_TOKEN_KEY);
}

export function hasAuthToken(): boolean {
  return Boolean(authToken);
}

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return serverUrl ? `${serverUrl}${cleanPath}` : cleanPath;
}

/** URL for <audio> and <img> elements. Appends short-lived ?mt= media token when talking cross-origin (native mobile). */
export function apiMediaUrl(path: string): string {
  const base = apiUrl(path);
  if (!mediaToken || !serverUrl) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}mt=${encodeURIComponent(mediaToken)}`;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: serverUrl ? "omit" : "include",
  });
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    unauthorizedListeners.forEach((fn) => fn());
  }
  return response;
}

export async function testServerHealth(rawUrl: string): Promise<{ ok: true; url: string; auth: boolean; sync: boolean } | { ok: false; error: string }> {
  const url = normalizeServerUrl(rawUrl);
  if (!url) return { ok: false, error: "Enter your Longform server URL." };
  try {
    new URL(url);
  } catch {
    return { ok: false, error: "That doesn’t look like a valid URL." };
  }
  try {
    const res = await fetch(`${url}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, error: `Server responded with ${res.status}.` };
    const data = (await res.json().catch(() => null)) as { ok?: boolean; auth?: boolean; sync?: boolean } | null;
    if (!data?.ok) return { ok: false, error: "That URL doesn’t appear to be a Longform server." };
    return { ok: true, url, auth: Boolean(data.auth), sync: Boolean(data.sync) };
  } catch {
    return { ok: false, error: "Couldn’t reach that server. Check the address and your connection." };
  }
}
