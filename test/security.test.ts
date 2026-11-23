import { afterEach, describe, expect, it } from "vitest";
import { app } from "../server/app";
import {
  checkLoginRateLimit,
  createSessionToken,
  isAllowedEmail,
  readSessionToken,
  recordFailedLogin,
  resetLoginRateLimit,
  verifyPassword,
  verifySessionToken,
} from "../server/auth";
import { isPublicIp, isSafeHttpUrl } from "../server/news";

const ENV_KEYS = ["APP_PASSWORD", "SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS", "PUBLIC_URL"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

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

  it("protects /api/* when APP_PASSWORD is set and sets HttpOnly cookie on login", async () => {
    process.env.APP_PASSWORD = "my-secret-passcode";
    process.env.SESSION_SECRET = "signing-key-123";

    const statusBefore = await app.request("/api/auth/status");
    expect(await statusBefore.json()).toEqual({
      protected: true,
      authenticated: false,
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
      body: JSON.stringify({ password: "my-secret-passcode" }),
    });
    expect(goodLogin.status).toBe(200);
    const cookie = goodLogin.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("longform_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const cookiePair = cookie.split(";")[0];
    const statusAfter = await app.request("/api/auth/status", { headers: { Cookie: cookiePair } });
    expect(await statusAfter.json()).toEqual({
      protected: true,
      authenticated: true,
      methods: { google: false, password: true },
    });
    expect(statusAfter.headers.get("x-content-type-options")).toBe("nosniff");
    expect(statusAfter.headers.get("x-frame-options")).toBe("DENY");
  });

  it("supports Google OAuth PKCE + strict ALLOWED_EMAILS allowlist and instant revocation", async () => {
    process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "secret-xyz";
    process.env.ALLOWED_EMAILS = "Alice@Gmail.com, bob@example.com";
    process.env.SESSION_SECRET = "signing-key-google";

    expect(isAllowedEmail("alice@gmail.com")).toBe(true);
    expect(isAllowedEmail("stranger@gmail.com")).toBe(false);

    const status = await app.request("/api/auth/status");
    expect(await status.json()).toEqual({
      protected: true,
      authenticated: false,
      methods: { google: true, password: false },
    });

    const start = await app.request("https://longform-beta.vercel.app/api/auth/google");
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    expect(loc.origin).toBe("https://accounts.google.com");
    expect(loc.searchParams.get("client_id")).toBe("client-123.apps.googleusercontent.com");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://longform-beta.vercel.app/api/auth/google/callback");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(start.headers.get("set-cookie")).toContain("longform_oauth=");

    const aliceToken = createSessionToken(1_000_000, "alice@gmail.com");
    expect(readSessionToken(aliceToken, 1_000_010)).toMatchObject({ email: "alice@gmail.com" });

    // Removing alice from ALLOWED_EMAILS immediately invalidates her token.
    process.env.ALLOWED_EMAILS = "bob@example.com";
    expect(readSessionToken(aliceToken, 1_000_010)).toBeNull();
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
