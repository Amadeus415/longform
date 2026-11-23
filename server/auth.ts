import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

const COOKIE_NAME = "longform_session";
const OAUTH_COOKIE = "longform_oauth";
const SESSION_TTL_SEC = 90 * 24 * 60 * 60; // 90 days for personal phone PWA
const OAUTH_TTL_SEC = 10 * 60; // 10 minutes
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

type AttemptBucket = { count: number; resetAt: number };
const attempts = new Map<string, AttemptBucket>();

export type SessionInfo = { exp: number; email?: string };

export function allowedEmails(): Set<string> {
  const raw = process.env.ALLOWED_EMAILS ?? "";
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@")),
  );
}

export function isAllowedEmail(email: string | undefined): boolean {
  if (!email) return false;
  return allowedEmails().has(email.trim().toLowerCase());
}

export function isPasswordAuthEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD?.trim());
}

export function isGoogleAuthEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim() &&
      allowedEmails().size > 0,
  );
}

export function isAuthEnabled(): boolean {
  return isGoogleAuthEnabled() || isPasswordAuthEnabled();
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyPassword(candidate: string, expected = process.env.APP_PASSWORD ?? ""): boolean {
  const cleanExpected = expected.trim();
  if (!cleanExpected || typeof candidate !== "string") return false;
  return timingSafeEqual(sha256(candidate), sha256(cleanExpected));
}

function signingKey(purpose: string): Buffer {
  const secret =
    process.env.SESSION_SECRET?.trim() ||
    process.env.GOOGLE_CLIENT_SECRET?.trim() ||
    process.env.APP_PASSWORD?.trim() ||
    "";
  return createHash("sha256").update(`longform:${purpose}:v1:${secret}`, "utf8").digest();
}

function signPayload(payload: object, purpose: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", signingKey(purpose)).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyPayload<T>(token: string | undefined, purpose: string): T | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!encoded || !sig) return null;

  const expected = createHmac("sha256", signingKey(purpose)).update(encoded).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function createSessionToken(nowSec = Math.floor(Date.now() / 1000), email?: string): string {
  const payload: SessionInfo = { exp: nowSec + SESSION_TTL_SEC, ...(email ? { email: email.toLowerCase() } : {}) };
  return signPayload(payload, "session");
}

export function readSessionToken(token: string | undefined, nowSec = Math.floor(Date.now() / 1000)): SessionInfo | null {
  if (!isAuthEnabled()) return null;
  const payload = verifyPayload<SessionInfo>(token, "session");
  if (!payload || typeof payload.exp !== "number" || payload.exp <= nowSec) return null;
  // If Google allowlist is active and session belongs to an email, ensure it is still allowed.
  if (payload.email && isGoogleAuthEnabled() && !isAllowedEmail(payload.email)) return null;
  // If only Google auth is enabled (no password fallback), require an allowed email in the session.
  if (!isPasswordAuthEnabled() && (!payload.email || !isAllowedEmail(payload.email))) return null;
  return payload;
}

export function verifySessionToken(token: string | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return readSessionToken(token, nowSec) !== null;
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

export function getSession(c: Context): SessionInfo | null {
  if (!isAuthEnabled()) return null;
  return readSessionToken(parseCookie(c.req.header("cookie"), COOKIE_NAME));
}

export function isAuthenticated(c: Context): boolean {
  if (!isAuthEnabled()) return true;
  return getSession(c) !== null;
}

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return c.req.url.startsWith("https://") || process.env.NODE_ENV === "production";
}

function cookieString(c: Context, name: string, value: string, maxAgeSec: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecureRequest(c) ? ["Secure"] : []),
  ].join("; ");
}

export function setSessionCookie(c: Context, email?: string): void {
  const token = createSessionToken(Math.floor(Date.now() / 1000), email);
  c.header("Set-Cookie", cookieString(c, COOKIE_NAME, token, SESSION_TTL_SEC), { append: true });
}

export function clearSessionCookie(c: Context): void {
  c.header("Set-Cookie", cookieString(c, COOKIE_NAME, "", 0), { append: true });
}

// ---------- Google OAuth 2.0 + PKCE ----------

type OAuthState = { state: string; verifier: string; exp: number };

export function oauthCallbackUrl(c: Context): string {
  const explicit = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (explicit) return `${explicit}/api/auth/google/callback`;
  const host = c.req.header("x-forwarded-host") || c.req.header("host");
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() || (c.req.url.startsWith("https://") ? "https" : "http");
  if (host) return `${proto}://${host}/api/auth/google/callback`;
  return new URL("/api/auth/google/callback", c.req.url).toString();
}

export function startGoogleAuth(c: Context): Response {
  if (!isGoogleAuthEnabled()) return c.redirect("/?authError=unavailable", 302);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const oauthToken = signPayload({ state, verifier, exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_SEC } satisfies OAuthState, "oauth");

  c.header("Cache-Control", "no-store");
  c.header("Set-Cookie", cookieString(c, OAUTH_COOKIE, oauthToken, OAUTH_TTL_SEC), { append: true });

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
    redirect_uri: oauthCallbackUrl(c),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
}

export async function finishGoogleAuth(c: Context): Promise<Response> {
  c.header("Cache-Control", "no-store");
  c.header("Set-Cookie", cookieString(c, OAUTH_COOKIE, "", 0), { append: true });

  if (!isGoogleAuthEnabled()) return c.redirect("/?authError=unavailable", 302);
  const errorParam = c.req.query("error");
  if (errorParam) return c.redirect("/?authError=cancelled", 302);

  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const saved = verifyPayload<OAuthState>(parseCookie(c.req.header("cookie"), OAUTH_COOKIE), "oauth");
  const nowSec = Math.floor(Date.now() / 1000);
  if (!code || !state || !saved || saved.exp <= nowSec) return c.redirect("/?authError=expired", 302);

  const stateA = Buffer.from(state, "utf8");
  const stateB = Buffer.from(saved.state, "utf8");
  if (stateA.length !== stateB.length || !timingSafeEqual(stateA, stateB)) {
    return c.redirect("/?authError=expired", 302);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!.trim(),
        client_secret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
        redirect_uri: oauthCallbackUrl(c),
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) {
      console.error(`[auth] Google token exchange failed: ${tokenRes.status}`);
      return c.redirect("/?authError=failed", 302);
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) return c.redirect("/?authError=failed", 302);

    const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) return c.redirect("/?authError=failed", 302);
    const user = (await userRes.json()) as { email?: string; email_verified?: boolean };
    if (!user.email || !user.email_verified || !isAllowedEmail(user.email)) {
      return c.redirect("/?authError=unauthorized", 302);
    }

    setSessionCookie(c, user.email.toLowerCase());
    return c.redirect("/", 302);
  } catch (error) {
    console.error(`[auth] Google callback error: ${(error as Error).message}`);
    return c.redirect("/?authError=failed", 302);
  }
}

// ---------- Password login rate limit ----------

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

// ---------- Middleware ----------

const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/google",
  "/api/auth/google/callback",
]);

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
