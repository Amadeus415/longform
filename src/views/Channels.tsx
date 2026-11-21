import { useRef, useState, type FormEvent } from "react";
import { findChannels, parseSubscriptions, refreshFeeds } from "../lib/feed";
import { STARTER_PACKS } from "../lib/starter";
import { addChannels, exportData, importData, removeChannel, updateSettings, useStore } from "../lib/store";
import type { ChannelHit } from "../lib/types";
import { REPO_URL, Segmented } from "./ui";

export function Channels({ onRules }: { onRules: () => void }) {
  const { channels, settings } = useStore();
  const have = new Set(channels.map((c) => c.id));
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ChannelHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const takeout = useRef<HTMLInputElement>(null);
  const backup = useRef<HTMLInputElement>(null);

  const add = (list: { id: string; title: string }[]) => {
    const added = addChannels(list);
    setMessage(added ? `Added ${added} channel${added === 1 ? "" : "s"}.` : "Already in your channels.");
    refreshFeeds();
  };

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const results = await findChannels(query);
      setHits(results);
      if (!results.length) setMessage("No channels found. Try their @handle or a link to one of their videos.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const readFile = (input: HTMLInputElement | null, use: (text: string) => void) => {
    const file = input?.files?.[0];
    if (!file) return;
    file.text().then(use).catch(() => setMessage("Couldn’t read that file."));
    input.value = "";
  };

  return (
    <div className="page">
      <form className="search" onSubmit={search}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Add a channel: name, @handle, or link"
          aria-label="Add a channel"
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="search"
        />
        <button className="button" disabled={busy}>{busy ? "…" : "Find"}</button>
      </form>
      {message && <p className="note" role="status">{message}</p>}

      {hits && hits.length > 0 && (
        <ul className="list hits">
          {hits.map((hit) => (
            <li key={hit.id} className="item">
              {hit.thumbnail ? <img className="avatar" src={hit.thumbnail} alt="" /> : <span className="avatar" />}
              <div className="row-text">
                <span className="row-title">{hit.title}</span>
                <span className="meta">{[hit.handle, hit.subscribers].filter(Boolean).join(" · ")}</span>
              </div>
              {have.has(hit.id) ? (
                <span className="quiet">Added</span>
              ) : (
                <button className="button" onClick={() => add([{ id: hit.id, title: hit.title }])}>Add</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <section>
        <h2 className="label">Your channels · {channels.length}</h2>
        {channels.length === 0 ? (
          <p className="quiet">None yet. Search above, add a pack, or import your subscriptions.</p>
        ) : (
          <ul className="list">
            {[...channels].sort((a, b) => a.title.localeCompare(b.title)).map((c) => (
              <li key={c.id} className="item">
                <a className="row-title grow" href={`https://www.youtube.com/channel/${c.id}`} target="_blank" rel="noreferrer">
                  {c.title || c.id}
                </a>
                <button className="link muted" onClick={() => removeChannel(c.id)} aria-label={`Remove ${c.title}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="label">Starter packs</h2>
        <ul className="list">
          {STARTER_PACKS.map((pack) => {
            const missing = pack.channels.filter((c) => !have.has(c.id));
            return (
              <li key={pack.name} className="item">
                <div className="row-text">
                  <span className="row-title">{pack.name}</span>
                  <span className="meta">{pack.about}</span>
                </div>
                {missing.length ? (
                  <button className="button" onClick={() => add(missing)}>Add {missing.length}</button>
                ) : (
                  <span className="quiet">Added</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="label">Import YouTube subscriptions</h2>
        <ol className="steps">
          <li>
            Open <a href="https://takeout.google.com/" target="_blank" rel="noreferrer">Google Takeout</a>, click “Deselect all”, then
            tick <b>YouTube and YouTube Music</b>.
          </li>
          <li>Under “All YouTube data included”, keep only <b>subscriptions</b>. Export and download.</li>
          <li>Choose the <code>subscriptions.csv</code> file from the download:</li>
        </ol>
        <input
          ref={takeout}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={() =>
            readFile(takeout.current, (text) => {
              const found = parseSubscriptions(text);
              if (found.length) add(found);
              else setMessage("No channels found in that file.");
            })
          }
        />
        <button className="button" onClick={() => takeout.current?.click()}>Choose subscriptions.csv</button>
      </section>

      <section>
        <h2 className="label">Settings</h2>
        <div className="setting">
          <span>Filter rules and their history</span>
          <button className="button" onClick={onRules}>Open</button>
        </div>
        <div className="setting">
          <span>Tapping a video should</span>
          <Segmented value={settings.mode} options={[["listen", "Listen"], ["watch", "Watch"]]} onChange={(mode) => updateSettings({ mode })} />
        </div>
        <label className="setting">
          <span>When the screen locks mid-video, keep playing as audio</span>
          <input type="checkbox" className="switch" checked={settings.continueOnLock} onChange={(e) => updateSettings({ continueOnLock: e.target.checked })} />
        </label>
        <div className="setting">
          <span>Thumbnails</span>
          <Segmented value={settings.frames ? "on" : "off"} options={[["on", "Frames"], ["off", "Off"]]} onChange={(v) => updateSettings({ frames: v === "on" })} />
        </div>
        <div className="setting">
          <span>Theme</span>
          <Segmented value={settings.theme} options={[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]} onChange={(theme) => updateSettings({ theme })} />
        </div>
      </section>

      <section>
        <h2 className="label">Backup</h2>
        <p className="quiet">Everything lives on this device. Move it to another one with a backup file.</p>
        <div className="actions">
          <button
            className="button"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([exportData()], { type: "application/json" }));
              const a = Object.assign(document.createElement("a"), { href: url, download: `longform-${new Date().toISOString().slice(0, 10)}.json` });
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export
          </button>
          <input
            ref={backup}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={() =>
              readFile(backup.current, (text) => {
                try {
                  importData(text);
                  setMessage("Backup restored.");
                  refreshFeeds(true);
                } catch (error) {
                  setMessage((error as Error).message || "That file isn’t a Longform backup.");
                }
              })
            }
          />
          <button className="button" onClick={() => backup.current?.click()}>Import</button>
        </div>
      </section>

      <footer className="end">
        <p>
          Longform is open source. <a href={REPO_URL} target="_blank" rel="noreferrer">Read the code</a>, including the{" "}
          <a href={`${REPO_URL}/blob/main/src/lib/filter.ts`} target="_blank" rel="noreferrer">whole filter</a>.
        </p>
      </footer>
    </div>
  );
}
