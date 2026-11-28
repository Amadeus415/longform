import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../server/app";
import {
  checkLoginRateLimit,
  createMediaToken,
  createSessionToken,
  isAllowedEmail,
  readMediaToken,
  readSessionToken,
  recordFailedLogin,
  resetLoginRateLimit,
  verifyPassword,
  verifySessionToken,
} from "../server/auth";
import { createNativeAuthCode, resetDbForTests, upsertUser } from "../server/db";
import { isPublicIp, isSafeHttpUrl } from "../server/news";

const ENV_KEYS = [
  "APP_PASSWORD",
  "SESSION_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
  "ALLOW_PUBLIC_SIGNUP",
  "ADMIN_EMAILS",
  "PUBLIC_URL",
  "DATABASE_PATH",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  resetDbForTests(":memory:");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetLoginRateLimit("test-ip");
});

describe("auth & session tokens", () => {
  it("verifies passwords in constant time and signs/verifies session cookies", () => {
    process.env.APP_PASSWORD = "correct-horse-battery";
    process.env.SESSION_SECRET = "random-signing-secret";
    expect(verifyPassword("correct-horse-battery")).toBe(true);
    expect(verifyPassword("wrong")).toBe(false);
    expect(verifyPassword("correct-horse-batter")).toBe(false);

    const token = createSessionToken(1_000_000);
    expect(verifySessionToken(token, 1_000_010)).toBe(true);
    expect(verifySessionToken(`${token}x`, 1_000_010)).toBe(false);
    expect(verifySessionToken(token, 1_000_000 + 91 * 86_400)).toBe(false);
  });

  it("rate-limits repeated failed logins", () => {
    const t = Date.now();
    for (let i = 0; i < 10; i++) {
      expect(checkLoginRateLimit("test-ip", t).ok).toBe(true);
      recordFailedLogin("test-ip", t);
    }
    expect(checkLoginRateLimit("test-ip", t).ok).toBe(false);
    expect(checkLoginRateLimit("test-ip", t + 16 * 60_000).ok).toBe(true);
  });

  it("protects /api/* when APP_PASSWORD is set and supports both HttpOnly cookies and native Bearer tokens", async () => {
    process.env.APP_PASSWORD = "my-secret-passcode";
    process.env.SESSION_SECRET = "signing-key-123";

    const statusBefore = await app.request("/api/auth/status");
    expect(await statusBefore.json()).toMatchObject({
      protected: true,
      authenticated: false,
      syncEnabled: false,
      methods: { google: false, password: true },
    });

    const blocked = await app.request("/api/news/source?id=hn:front_page");
    expect(blocked.status).toBe(401);

    const badLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "test-ip" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(badLogin.status).toBe(401);

    const goodLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "test-ip" },
      body: JSON.stringify({ password: "my-secret-passcode", native: true }),
    });
    expect(goodLogin.status).toBe(200);
    const cookie = goodLogin.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("longform_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const loginBody = (await goodLogin.json()) as { ok: boolean; token?: string; mediaToken?: string };
    expect(loginBody.ok).toBe(true);
    expect(loginBody.token).toBeTruthy();
    expect(loginBody.mediaToken).toBeTruthy();

    const cookiePair = cookie.split(";")[0];
    const statusAfter = await app.request("/api/auth/status", { headers: { Cookie: cookiePair } });
    expect(await statusAfter.json()).toMatchObject({
      protected: true,
      authenticated: true,
      syncEnabled: true,
      methods: { google: false, password: true },
    });
    expect(statusAfter.headers.get("x-content-type-options")).toBe("nosniff");
    expect(statusAfter.headers.get("x-frame-options")).toBe("DENY");
    expect(statusAfter.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");

    // Native Bearer token also authenticates cleanly.
    const bearerStatus = await app.request("/api/auth/status", {
      headers: { Authorization: `Bearer ${loginBody.token}` },
    });
    expect(await bearerStatus.json()).toMatchObject({
      authenticated: true,
      syncEnabled: true,
    });
  });

  it("supports Google OAuth PKCE + strict ALLOWED_EMAILS allowlist and instant revocation", async () => {
    process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "secret-xyz";
    process.env.ALLOWED_EMAILS = "Alice@Gmail.com, bob@example.com";
    process.env.SESSION_SECRET = "signing-key-google";

    expect(isAllowedEmail("alice@gmail.com")).toBe(true);
    expect(isAllowedEmail("stranger@gmail.com")).toBe(false);

    const status = await app.request("/api/auth/status");
    expect(await status.json()).toMatchObject({
      protected: true,
      authenticated: false,
      publicSignup: false,
      methods: { google: true, password: false },
    });

    const start = await app.request("https://longform.fly.dev/api/auth/google");
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    expect(loc.origin).toBe("https://accounts.google.com");
    expect(loc.searchParams.get("client_id")).toBe("client-123.apps.googleusercontent.com");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://longform.fly.dev/api/auth/google/callback");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(start.headers.get("set-cookie")).toContain("longform_oauth=");

    const aliceToken = createSessionToken(1_000_000, "alice@gmail.com");
    expect(readSessionToken(aliceToken, 1_000_010)).toMatchObject({ email: "alice@gmail.com" });

    // Removing alice from ALLOWED_EMAILS immediately invalidates her token.
    process.env.ALLOWED_EMAILS = "bob@example.com";
    expect(readSessionToken(aliceToken, 1_000_010)).toBeNull();

    // Flipping ALLOW_PUBLIC_SIGNUP=true allows any verified Google email to join.
    process.env.ALLOW_PUBLIC_SIGNUP = "true";
    expect(isAllowedEmail("newfriend@gmail.com")).toBe(true);
  });

  it("scopes media tokens strictly to media routes and exchanges native OAuth codes once", async () => {
    process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "secret-xyz";
    process.env.ALLOW_PUBLIC_SIGNUP = "true";
    process.env.SESSION_SECRET = "signing-key-media";

    const user = upsertUser({ id: "google:sub-1", email: "user@example.com", name: "User One", role: "user" })!;
    const mediaToken = createMediaToken({ uid: user.id, email: user.email ?? undefined });
    expect(readMediaToken(mediaToken)).toMatchObject({ uid: "google:sub-1", email: "user@example.com" });

    // Media token must NEVER grant access to /api/me/state.
    const stateBlocked = await app.request(`/api/me/state?mt=${encodeURIComponent(mediaToken)}`);
    expect(stateBlocked.status).toBe(401);

    // Media token passes auth on /api/avatar/:id (400 = invalid channel id, proving auth passed).
    const mediaAllowed = await app.request(`/api/avatar/not-a-channel?mt=${encodeURIComponent(mediaToken)}`);
    expect(mediaAllowed.status).toBe(400);

    // Native one-time code exchanges once and cannot be replayed.
    const code = createNativeAuthCode(user)!;
    const first = await app.request("/api/auth/native/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);
    const exchanged = (await first.json()) as { ok: boolean; token: string; mediaToken: string; user: { email: string } };
    expect(exchanged.ok).toBe(true);
    expect(exchanged.token).toBeTruthy();
    expect(exchanged.user.email).toBe("user@example.com");

    const replay = await app.request("/api/auth/native/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(401);
  });

  it("allows Capacitor native CORS origins on /api/*", async () => {
    const res = await app.request("/api/health", {
      headers: { Origin: "capacitor://localhost" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
  });
});

describe("SSRF IP & URL validation", () => {
  it("blocks private, loopback, metadata, and IPv4-mapped private addresses", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("10.0.0.5")).toBe(false);
    expect(isPublicIp("172.16.0.1")).toBe(false);
    expect(isPublicIp("192.168.1.1")).toBe(false);
    expect(isPublicIp("169.254.169.254")).toBe(false);
    expect(isPublicIp("100.64.0.1")).toBe(false);
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicIp("1.1.1.1")).toBe(true);
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);

    expect(isSafeHttpUrl("https://user:pass@example.com/feed")).toBe(false);
    expect(isSafeHttpUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isSafeHttpUrl("https://feeds.bbci.co.uk/news/world/rss.xml")).toBe(true);
  });
});
