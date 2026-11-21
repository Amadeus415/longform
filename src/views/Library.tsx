import { useMemo, useRef, useState } from "react";
import { refreshFeeds } from "../lib/feed";
import { navigate } from "../lib/nav";
import { play } from "../lib/player";
import { dayKey, exportData, importData, updateSettings, useStore } from "../lib/store";
import { toVideo } from "../lib/useFeed";
import { Avatar, Frame, Icon, REPO_URL, Segmented, Toggle, span, toast } from "./ui";

export function Library() {
  const settings = useStore((s) => s.settings);
  const channels = useStore((s) => s.channels);
  const progress = useStore((s) => s.progress);
  const backup = useRef<HTMLInputElement>(null);
  const recent = useMemo(() => Object.values(progress).sort((a, b) => b.at - a.at).slice(0, 12), [progress]);

  return (
    <div className="view">
      <header className="large-title"><h1>Library</h1></header>

      {recent.length > 0 && (
        <section>
          <div className="section-head"><h2>Recently played</h2></div>
          <div className="carousel">
            {recent.map((p) => (
              <button key={p.video.id} className="mini-card press" onClick={() => play(toVideo(p))}>
                <div className="media">
                  <Frame id={p.video.id} size="small" />
                  {!p.done && <div className="progress"><span style={{ width: `${(p.t / p.d) * 100}%` }} /></div>}
                </div>
                <div>
                  <div className="t">{p.video.title}</div>
                  <div className="s">{p.done ? "Finished" : `${span(p.d - p.t)} left`}</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="narrow">
        <Week />
        <div className="section-head"><h2>Following</h2></div>
        <div className="group">
          <button className="row" onClick={() => navigate("library/channels")}>
            <span className="label">Channels<small>{channels.length ? `${channels.length} channels` : "Add the channels you trust"}</small></span>
            <span className="stack-avatars">
              {channels.slice(0, 4).map((c) => <Avatar key={c.id} id={c.id} title={c.title} size={28} />)}
            </span>
            <span className="chev"><Icon name="right" size={18} /></span>
          </button>
        </div>

        <div className="section-head"><h2>Playback</h2></div>
        <div className="group">
          <div className="row static">
            <span className="label">Tapping a video starts</span>
            <Segmented value={settings.mode} options={[["listen", "Audio"], ["watch", "Video"]]} onChange={(mode) => updateSettings({ mode })} />
          </div>
          <div className="row static">
            <span className="label">Keep playing when the screen locks<small>Switches a video to audio at the same second</small></span>
            <Toggle checked={settings.continueOnLock} onChange={(continueOnLock) => updateSettings({ continueOnLock })} label="Keep playing when the screen locks" />
          </div>
        </div>

        <div className="section-head"><h2>Appearance</h2></div>
        <div className="group">
          <div className="row static">
            <span className="label">Show video frames<small>Turn off for a calm, text-only feed</small></span>
            <Toggle checked={settings.frames} onChange={(frames) => updateSettings({ frames })} label="Show video frames" />
          </div>
          <div className="row static">
            <span className="label">Theme</span>
            <Segmented value={settings.theme} options={[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]} onChange={(theme) => updateSettings({ theme })} />
          </div>
        </div>

        <div className="section-head"><h2>Your data</h2></div>
        <div className="group">
          <button
            className="row with-icon"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([exportData()], { type: "application/json" }));
              Object.assign(document.createElement("a"), { href: url, download: `longform-${new Date().toISOString().slice(0, 10)}.json` }).click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <span className="lead"><Icon name="upload" /></span>
            <span className="label">Export a backup<small>Channels, algorithm history, and progress</small></span>
          </button>
          <button className="row with-icon" onClick={() => backup.current?.click()}>
            <span className="lead"><Icon name="download" /></span>
            <span className="label">Restore from a backup</span>
          </button>
        </div>
        <p className="group-note" style={{ margin: "8px 28px 0", color: "var(--text-2)", fontSize: 13 }}>
          Everything stays on this device. There’s no account.
        </p>
        <input
          ref={backup}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              importData(await file.text());
              refreshFeeds(true);
              toast("Backup restored");
            } catch (error) {
              toast((error as Error).message || "That file isn’t a Longform backup.");
            }
          }}
        />

        <div className="section-head"><h2>About</h2></div>
        <div className="group">
          <a className="row with-icon" href={REPO_URL} target="_blank" rel="noreferrer">
            <span className="lead"><Icon name="code" /></span>
            <span className="label">Longform is open source<small>Read the code, suggest channels, report bugs</small></span>
            <span className="chev"><Icon name="external" size={18} /></span>
          </a>
          <a className="row with-icon" href={`${REPO_URL}/blob/main/src/lib/filter.ts`} target="_blank" rel="noreferrer">
            <span className="lead"><Icon name="algorithm" /></span>
            <span className="label">How the algorithm works<small>The whole filter is about 150 lines</small></span>
            <span className="chev"><Icon name="external" size={18} /></span>
          </a>
        </div>
      </div>
    </div>
  );
}

/** Time spent listening and watching this week, Monday to Sunday. */
function Week() {
  const listened = useStore((s) => s.listened);
  const progress = useStore((s) => s.progress);
  const [picked, setPicked] = useState<number | null>(null);

  const today = new Date();
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return { date: d, seconds: listened[dayKey(d)] ?? 0, isToday: dayKey(d) === dayKey(today), future: d > today };
  });
  const total = days.reduce((sum, d) => sum + d.seconds, 0);
  const everListened = Object.values(listened).some((seconds) => seconds >= 60);
  const peak = Math.max(...days.map((d) => d.seconds), 1);
  const finished = Object.values(progress).filter((p) => p.done && p.at >= monday.getTime()).length;
  const label = (seconds: number) => (seconds < 60 ? "0m" : span(seconds));

  if (!everListened) return null; // nothing to chart yet

  return (
    <section className="week" aria-label="Listening this week">
      <div className="week-head">
        <div>
          <div className="big">{label(total)}</div>
          <div className="cap">Listened this week</div>
        </div>
        <div className="done-count">
          <div className="big">{finished}</div>
          <div className="cap">Finished</div>
        </div>
      </div>
      <div className="bars" role="img" aria-label={days.map((d) => `${d.date.toLocaleDateString(undefined, { weekday: "long" })}: ${label(d.seconds)}`).join(", ")}>
        {days.map((d, i) => (
          <button key={i} onClick={() => setPicked(picked === i ? null : i)} onPointerEnter={() => setPicked(i)} onPointerLeave={() => setPicked(null)} aria-label={`${d.date.toLocaleDateString(undefined, { weekday: "long" })}: ${label(d.seconds)}`}>
            {picked === i && <span className="tip">{label(d.seconds)}</span>}
            <span className={`b${d.seconds < 60 ? " zero" : ""}`} style={{ height: d.seconds < 60 ? 3 : `${Math.max(6, (d.seconds / peak) * 100)}%` }} />
          </button>
        ))}
        {total < 60 && <span className="bars-empty">Nothing yet this week.</span>}
      </div>
      <div className="days" aria-hidden="true">
        {days.map((d, i) => (
          <span key={i} className={d.isToday ? "today" : ""}>{d.date.toLocaleDateString(undefined, { weekday: "narrow" })}</span>
        ))}
      </div>
    </section>
  );
}
