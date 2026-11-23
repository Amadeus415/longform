import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

const COOKIE_NAME = "longform_session";
const SESSION_TTL_SEC = 90 * 24 * 60 * 60; // 90 days for personal phone PWA
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

type AttemptBucket = { count: number; resetAt: number };
const attempts = new Map<string, AttemptBucket>();

export function isAuthEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD?.trim());
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyPassword(candidate: string, expected = process.env.APP_PASSWORD ?? ""): boolean {
  const cleanExpected = expected.trim();
  if (!cleanExpected || typeof candidate !== "string") return false;
  return timingSafeEqual(sha256(candidate), sha256(cleanExpected));
}

function signingKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim() || process.env.APP_PASSWORD?.trim() || "";
  return createHash("sha256").update(`longform:session:v1:${secret}`, "utf8").digest();
}

export function createSessionToken(nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = String(nowSec + SESSION_TTL_SEC);
  const sig = createHmac("sha256", signingKey()).update(exp).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifySessionToken(token: string | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!token || !isAuthEnabled()) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expStr) || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= nowSec) return false;

  const expected = createHmac("sha256", signingKey()).update(expStr).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function isAuthenticated(c: Context): boolean {
  if (!isAuthEnabled()) return true;
  const token = parseCookie(c.req.header("cookie"), COOKIE_NAME);
  return verifySessionToken(token);
}

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return c.req.url.startsWith("https://") || process.env.NODE_ENV === "production";
}

export function setSessionCookie(c: Context): void {
  const token = createSessionToken();
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_SEC}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecureRequest(c) ? ["Secure"] : []),
  ];
  c.header("Set-Cookie", attrs.join("; "));
}

export function clearSessionCookie(c: Context): void {
  const attrs = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecureRequest(c) ? ["Secure"] : []),
  ];
  c.header("Set-Cookie", attrs.join("; "));
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "local";
}

export function checkLoginRateLimit(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
  const bucket = attempts.get(key);
  if (!bucket || bucket.resetAt <= now) return { ok: true };
  if (bucket.count >= MAX_ATTEMPTS) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

export function recordFailedLogin(key: string, now = Date.now()): void {
  const bucket = attempts.get(key);
  if (!bucket || bucket.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    bucket.count += 1;
  }
  if (attempts.size > 2000) {
    for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
  }
}

export function resetLoginRateLimit(key: string): void {
  attempts.delete(key);
}

export function loginRateKey(c: Context): string {
  return clientIp(c);
}

const PUBLIC_API_PATHS = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/logout"]);

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Never let a shared CDN cache authenticated private API responses.
  if (isAuthEnabled() && c.req.path.startsWith("/api/") && !PUBLIC_API_PATHS.has(c.req.path)) {
    const existing = c.res.headers.get("Cache-Control");
    if (!existing || existing.includes("public") || existing.includes("s-maxage")) {
      c.header("Cache-Control", "private, max-age=300");
    }
  }
};

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!isAuthEnabled() || PUBLIC_API_PATHS.has(c.req.path)) return next();
  if (!isAuthenticated(c)) {
    c.header("Cache-Control", "no-store");
    return c.json({ error: "Authentication required" }, 401);
  }
  return next();
};
