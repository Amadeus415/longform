import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "./ui";

const AUTH_ERRORS: Record<string, string> = {
  unauthorized: "That Google account isn’t authorized for this app.",
  cancelled: "Google sign-in was cancelled.",
  expired: "Sign-in session expired. Please try again.",
  failed: "Could not complete Google sign-in. Try again in a moment.",
  unavailable: "Google sign-in is not configured on this server.",
};

export function Lock({
  methods,
  onUnlocked,
}: {
  methods: { google: boolean; password: boolean };
  onUnlocked: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = new URLSearchParams(location.search).get("authError");
    return code ? AUTH_ERRORS[code] ?? "Sign-in failed." : null;
  });

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.has("authError")) {
      params.delete("authError");
      const qs = params.toString();
      history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
    }
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onUnlocked();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(typeof data?.error === "string" ? data.error : "Incorrect passcode.");
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <img className="appicon" src="/icons/icon-512.png" alt="" />
        <h1>Longform</h1>
        <p className="lede">Sign in to open your videos and daily news brief.</p>

        {methods.google && (
          <a className="btn big google-btn press" href="/api/auth/google">
            <GoogleMark />
            <span>Continue with Google</span>
          </a>
        )}

        {methods.google && methods.password && <div className="lock-divider"><span>or passcode</span></div>}

        {methods.password && (
          <form className="lock-form" onSubmit={submit}>
            <label className="field">
              <Icon name="you" size={18} />
              <input
                type="password"
                value={password}
                onChange={(e) => (setPassword(e.target.value), setError(null))}
                placeholder="Passcode"
                autoComplete="current-password"
                autoFocus={!methods.google}
              />
            </label>
            <button className="btn accent big press" type="submit" disabled={!password || busy}>
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </form>
        )}

        {error && <p className="lock-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.08 3.56-5.15 3.56-8.65z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.9l-3.87-3a7.17 7.17 0 0 1-10.67-3.76H1.4v3.09A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.39 14.34a7.2 7.2 0 0 1 0-4.68V6.57H1.4a12 12 0 0 0 0 10.86l3.99-3.09z" />
      <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.4 6.57l3.99 3.09A7.17 7.17 0 0 1 12 4.75z" />
    </svg>
  );
}
