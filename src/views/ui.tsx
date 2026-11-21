import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

export const REPO_URL = "https://github.com/Amadeus415/longform";

// ---------- icons: one 24px outline family, 1.8 stroke ----------

const STROKE: Record<string, string> = {
  home: "M3.5 10.2 12 3.5l8.5 6.7V19.5a1 1 0 0 1-1 1H15v-6.2H9v6.2H4.5a1 1 0 0 1-1-1z",
  channels: "M6.5 3.8h11M4.8 7h14.4M5 10.2h14a2 2 0 0 1 2 2v6.3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6.3a2 2 0 0 1 2-2z",
  algorithm: "M4 7h8.5M16.5 7H20M4 17h2.5M10.5 17H20M14.5 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  you: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  search: "M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6zM15.8 15.8 20.5 20.5",
  back: "M4.2 12a7.8 7.8 0 1 0 2.3-5.5L4.2 8.8M4.2 4.2v4.6h4.6",
  forward: "M19.8 12a7.8 7.8 0 1 1-2.3-5.5l2.3 2.3M19.8 4.2v4.6h-4.6",
  down: "M6 9.5l6 6 6-6",
  left: "M14.5 5.5 8 12l6.5 6.5",
  right: "M9.5 5.5 16 12l-6.5 6.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  external: "M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10",
  check: "M5 12.5l4.5 4.5L19 7.5",
  plus: "M12 5v14M5 12h14",
  headphones: "M4 17v-4.5a8 8 0 0 1 16 0V17M4 14.5h2.2a1.3 1.3 0 0 1 1.3 1.3v3.4a1.3 1.3 0 0 1-1.3 1.3H5.3A1.3 1.3 0 0 1 4 19.2zM20 14.5h-2.2a1.3 1.3 0 0 0-1.3 1.3v3.4a1.3 1.3 0 0 0 1.3 1.3h.9a1.3 1.3 0 0 0 1.3-1.3z",
  video: "M5 5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8.5 21h7M10.2 9.2v4.6l4-2.3z",
  done: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.2 12.3l2.6 2.6 5-5.2",
  unfollow: "M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 20.5a7 7 0 0 1 11.2-5.6M16 18h5",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15",
  download: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14",
  upload: "M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 19.5h14",
  restore: "M3.8 12a8.2 8.2 0 1 0 2.4-5.8L3.8 8.6M3.8 3.8v4.8h4.8M12 8v4.2l2.8 1.8",
  eyeOff: "M3.5 3.5l17 17M10.4 5.6A9.5 9.5 0 0 1 12 5.5c4.6 0 8.2 4 9.2 6.5a11 11 0 0 1-2.4 3.4M6.7 7.2A11.5 11.5 0 0 0 2.8 12c1 2.5 4.6 6.5 9.2 6.5a9 9 0 0 0 4-.9M10 10.2a2.6 2.6 0 0 0 3.7 3.6",
  code: "M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5",
  list: "M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01",
};

const FILLED: Record<string, string> = {
  homeFill: "M3.5 10.2 12 3.5l8.5 6.7V19.5a1 1 0 0 1-1 1H15v-6.2H9v6.2H4.5a1 1 0 0 1-1-1z",
  play: "M8 5.6v12.8a1 1 0 0 0 1.5.86l10.4-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z",
  pause: "M7.5 5h2.6a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM13.9 5h2.6a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-2.6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  more: "M5.5 13.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM12 13.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM18.5 13.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z",
};

export type IconName = keyof typeof STROKE | keyof typeof FILLED;

export function Icon({ name, size = 24, label, strong }: { name: IconName; size?: number; label?: string; strong?: boolean }) {
  const filled = FILLED[name];
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {filled ? (
        <path d={filled} fill="currentColor" />
      ) : (
        <path d={STROKE[name]} fill="none" stroke="currentColor" strokeWidth={strong ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {label && (
        <text x="12" y="15.3" textAnchor="middle" fontSize="6.6" fontWeight="700" fill="currentColor">
          {label}
        </text>
      )}
    </svg>
  );
}

// ---------- media ----------

const FRAME_SIZES = { small: ["mq2", "mqdefault"], medium: ["hq2", "sd2", "mqdefault"], large: ["maxres2", "sd2", "hq2", "mqdefault"] };

/**
 * A frame from the middle of the video, never the uploader's thumbnail: less clickbait, more signal.
 * Falls back through smaller frames when a video has no high-resolution one.
 */
export function Frame({ id, size = "large", className = "" }: { id: string; size?: keyof typeof FRAME_SIZES; className?: string }) {
  const [step, setStep] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setStep(0);
    setLoaded(false);
  }, [id, size]);
  const names = FRAME_SIZES[size];
  return (
    <img
      className={`frame-img ${loaded ? "loaded" : ""} ${className}`}
      src={`https://i.ytimg.com/vi/${id}/${names[Math.min(step, names.length - 1)]}.jpg`}
      alt=""
      loading="lazy"
      decoding="async"
      onLoad={(e) => {
        // YouTube answers a missing frame with a 120×90 grey placeholder instead of an error.
        if ((e.target as HTMLImageElement).naturalWidth <= 120 && step < names.length - 1) setStep(step + 1);
        else setLoaded(true);
      }}
      onError={() => (step < names.length - 1 ? setStep(step + 1) : setLoaded(true))}
    />
  );
}

export function Avatar({ id, title, size = 36, ring }: { id: string; title: string; size?: number; ring?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const initials = title.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <span className={`avatar${ring ? " ring" : ""}`} style={{ width: size, height: size }}>
      {failed ? (
        <span className="avatar-initials" style={{ fontSize: size * 0.38 }}>{initials || "?"}</span>
      ) : (
        <img
          src={`/api/avatar/${id}`}
          alt=""
          decoding="async"
          className={loaded ? "loaded" : ""}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

// ---------- sheets ----------

/** A bottom sheet. Drag it down by its handle (or anywhere when scrolled to the top) to dismiss. */
export function Sheet({
  onClose, children, label, className = "", full,
}: { onClose: () => void; children: ReactNode; label: string; className?: string; full?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number; at: number } | null>(null);
  const [closing, setClosing] = useState(false);

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 220);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("sheet-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("sheet-open");
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const el = panel.current!;
    const fromHandle = (e.target as HTMLElement).closest("[data-drag]");
    if (!fromHandle && el.scrollTop > 0) return;
    if ((e.target as HTMLElement).closest("input, textarea, button, a, iframe, [data-nodrag]") && !fromHandle) return;
    drag.current = { y: e.clientY, dy: 0, at: Date.now() };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dy = Math.max(0, e.clientY - drag.current.y);
    drag.current.dy = dy;
    panel.current!.style.transform = `translateY(${dy}px)`;
    panel.current!.style.transition = "none";
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const el = panel.current!;
    el.style.transition = "";
    const fast = d.dy / Math.max(1, Date.now() - d.at) > 0.6;
    if (d.dy > 120 || (fast && d.dy > 40)) close();
    else el.style.transform = "";
  };

  return (
    <div className={`sheet-root${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label={label}>
      <div className="scrim" onClick={close} />
      <div
        ref={panel}
        className={`sheet${full ? " full" : ""} ${className}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="grabber" data-drag aria-hidden="true" />
        {typeof children === "function" ? null : children}
      </div>
    </div>
  );
}

export type Action = { icon: IconName; label: string; run: () => void; danger?: boolean };

export function ActionSheet({ title, subtitle, actions, onClose }: { title: string; subtitle?: string; actions: Action[]; onClose: () => void }) {
  return (
    <Sheet onClose={onClose} label={title} className="actions-sheet">
      <div className="actions-head">
        <div className="actions-title">{title}</div>
        {subtitle && <div className="actions-subtitle">{subtitle}</div>}
      </div>
      <div className="actions-list">
        {actions.map((a) => (
          <button
            key={a.label}
            className={`action${a.danger ? " danger" : ""}`}
            onClick={() => {
              onClose();
              a.run();
            }}
          >
            <Icon name={a.icon} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

// ---------- controls ----------

export function Segmented<T extends string>({ value, options, onChange, className = "" }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; className?: string }) {
  const index = Math.max(0, options.findIndex(([key]) => key === value));
  return (
    <div className={`segmented ${className}`} role="tablist" style={{ "--count": options.length, "--index": index } as React.CSSProperties}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} className={value === key ? "on" : ""} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" role="switch" className="switch" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />;
}

// ---------- toasts ----------

type Toast = { id: number; text: string; action?: { label: string; run: () => void } };
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();
let toastId = 0;

export function toast(text: string, action?: Toast["action"]): void {
  const id = ++toastId;
  toasts = [...toasts.slice(-1), { id, text, action }];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastListeners.forEach((l) => l());
  }, action ? 5000 : 2600);
}

export function Toasts() {
  const list = useSyncExternalStore((l) => (toastListeners.add(l), () => toastListeners.delete(l)), () => toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                toasts = toasts.filter((x) => x.id !== t.id);
                toastListeners.forEach((l) => l());
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- formatting ----------

export function ago(iso: string, now = Date.now()): string {
  const seconds = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return "";
  const units: [number, string, string][] = [
    [31_536_000, "year", "years"], [2_592_000, "month", "months"], [604_800, "week", "weeks"],
    [86_400, "day", "days"], [3600, "hour", "hours"], [60, "minute", "minutes"],
  ];
  for (const [size, one, many] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${n === 1 ? one : many} ago`;
    }
  }
  return "Just now";
}

/** "3h 21m", "48m": how long something takes, the way people say it. */
export function span(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

// ---------- one action sheet for the whole app ----------

type ActionRequest = { title: string; subtitle?: string; actions: Action[] } | null;
let actionRequest: ActionRequest = null;
const actionListeners = new Set<() => void>();

export function showActions(request: NonNullable<ActionRequest>): void {
  actionRequest = request;
  actionListeners.forEach((l) => l());
}

export function ActionHost() {
  const request = useSyncExternalStore((l) => (actionListeners.add(l), () => actionListeners.delete(l)), () => actionRequest);
  if (!request) return null;
  return (
    <ActionSheet
      {...request}
      onClose={() => {
        actionRequest = null;
        actionListeners.forEach((l) => l());
      }}
    />
  );
}
