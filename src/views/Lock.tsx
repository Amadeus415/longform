import { useState, type FormEvent } from "react";
import { Icon } from "./ui";

export function Lock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <form className="lock-card" onSubmit={submit}>
        <img className="appicon" src="/icons/icon-512.png" alt="" />
        <h1>Longform</h1>
        <p className="lede">Enter your passcode to unlock your videos and daily news brief.</p>
        <label className="field">
          <Icon name="you" size={18} />
          <input
            type="password"
            value={password}
            onChange={(e) => (setPassword(e.target.value), setError(null))}
            placeholder="Passcode"
            autoComplete="current-password"
            autoFocus
          />
        </label>
        {error && <p className="lock-error" role="alert">{error}</p>}
        <button className="btn accent big press" type="submit" disabled={!password || busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
