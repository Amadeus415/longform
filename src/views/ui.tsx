import { useEffect, useState, type ReactNode } from "react";
import { clock } from "../lib/filter";

export const REPO_URL = "https://github.com/Amadeus415/longform";

const ICONS = {
  play: "M8 5.5v13a.5.5 0 0 0 .77.42l10.2-6.5a.5.5 0 0 0 0-.84L8.77 5.08A.5.5 0 0 0 8 5.5z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  back: "M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z",
  forward: "M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z",
  down: "M6.4 8.6 12 14.2l5.6-5.6L19 10l-7 7-7-7z",
  close: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z",
  left: "M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z",
  external: "M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14zM5 6h6v2H6v10h10v-5h2v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  refresh: "M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z",
};

export function Icon({ name, size = 22, label }: { name: keyof typeof ICONS; size?: number; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={ICONS[name]} fill="currentColor" />
      {label && (
        <text x="12" y="15.6" textAnchor="middle" fontSize="6.4" fontWeight="700" fill="currentColor" fontFamily="ui-monospace, monospace">
          {label}
        </text>
      )}
    </svg>
  );
}

/** A frame from the middle of the video, not the uploader's thumbnail. Less clickbait, more signal. */
export function Frame({ id, seconds, progress, large }: { id: string; seconds?: number | null; progress?: number; large?: boolean }) {
  const [src, setSrc] = useState(`https://i.ytimg.com/vi/${id}/${large ? "hq2" : "mq2"}.jpg`);
  useEffect(() => setSrc(`https://i.ytimg.com/vi/${id}/${large ? "hq2" : "mq2"}.jpg`), [id, large]);
  return (
    <div className={large ? "frame large" : "frame"}>
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setSrc(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`)} />
      {seconds ? <span className="stamp">{clock(seconds)}</span> : null}
      {progress ? <span className="bar" style={{ width: `${Math.min(100, progress * 100)}%` }} /> : null}
    </div>
  );
}

export function Sheet({ onClose, children, label, wide, tall }: { onClose: () => void; children: ReactNode; label: string; wide?: boolean; tall?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("locked");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("locked");
    };
  }, [onClose]);
  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label={label}>
      <div className="scrim" onClick={onClose} />
      <div className={`sheet${wide ? " wide" : ""}${tall ? " tall" : ""}`}>{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} className={value === key ? "on" : ""} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return "";
  const units: [number, string][] = [[31_536_000, "y"], [2_592_000, "mo"], [604_800, "w"], [86_400, "d"], [3600, "h"], [60, "m"]];
  for (const [size, unit] of units) if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  return "just now";
}

export function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
