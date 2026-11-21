import { useEffect, useRef, useState, type FormEvent } from "react";
import { findChannels, parseSubscriptions, refreshFeeds } from "../lib/feed";
import { intent, navigate } from "../lib/nav";
import { STARTER_PACKS } from "../lib/starter";
import { addChannels, useStore } from "../lib/store";
import type { ChannelHit } from "../lib/types";
import { unfollow } from "./actions";
import { Avatar, Icon, ago, showActions, toast } from "./ui";

export function Channels() {
  const channels = useStore((s) => s.channels);
  const feeds = useStore((s) => s.feeds);
  const have = new Set(channels.map((c) => c.id));
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ChannelHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const takeout = useRef<HTMLInputElement>(null);

  const add = (list: { id: string; title: string }[]) => {
    const added = addChannels(list);
    toast(added ? `Following ${added === 1 ? list[0].title : `${added} channels`}` : "Already following");
    refreshFeeds();
  };

  const search = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const results = await findChannels(q);
      setHits(results);
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (intent.channelQuery) {
      setQuery(intent.channelQuery);
      search(intent.channelQuery);
      intent.channelQuery = undefined;
    }
  }, []);

  const sorted = [...channels].sort((a, b) => a.title.localeCompare(b.title));

  return (
    <div className="view">
      <div className="back-bar">
        <button className="btn-back" onClick={() => navigate("library")}><Icon name="left" size={22} /> Library</button>
      </div>
      <header className="large-title" style={{ paddingTop: 4 }}>
        <div>
          <h1>Channels</h1>
          <p className="subtitle">{channels.length ? `Following ${channels.length}` : "Follow the channels you trust"}</p>
        </div>
      </header>

      <div className="narrow">
        <form className="page" onSubmit={(e: FormEvent) => (e.preventDefault(), search(query))} style={{ marginTop: 10 }}>
          <label className="field">
            <Icon name="search" size={20} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, @handle, or YouTube link" enterKeyHint="search" autoCapitalize="off" autoCorrect="off" />
            {busy && <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2, borderColor: "var(--line)", borderTopColor: "var(--text-2)" }} />}
          </label>
        </form>

        {hits && (
          <>
            <div className="section-head"><h2>Results</h2></div>
            {hits.length ? (
              <div className="group">
                {hits.map((hit) => (
                  <div key={hit.id} className="row with-avatar static">
                    {hit.thumbnail ? <span className="avatar" style={{ width: 44, height: 44 }}><img src={hit.thumbnail} alt="" /></span> : <Avatar id={hit.id} title={hit.title} size={44} />}
                    <span className="label">{hit.title}<small>{[hit.handle, hit.subscribers].filter(Boolean).join(" · ")}</small></span>
                    {have.has(hit.id) ? <span className="value">Following</span> : <button className="btn accent" onClick={() => add([{ id: hit.id, title: hit.title }])}>Follow</button>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty">No channels found. Try their @handle, or paste a link to one of their videos.</p>
            )}
          </>
        )}

        {channels.length > 0 && (
          <>
            <div className="section-head"><h2>Following</h2></div>
            <div className="group">
              {sorted.map((c) => {
                const newest = feeds[c.id]?.videos[0]?.published;
                return (
                  <div key={c.id} className="row with-avatar static">
                    <Avatar id={c.id} title={c.title} size={44} />
                    <span className="label">{c.title || c.id}<small>{newest ? `Latest upload ${ago(newest).toLowerCase()}` : "Loading…"}</small></span>
                    <button
                      className="icon-btn"
                      aria-label={`Options for ${c.title}`}
                      onClick={() =>
                        showActions({
                          title: c.title,
                          actions: [
                            { icon: "external", label: "Open in YouTube", run: () => window.open(`https://www.youtube.com/channel/${c.id}`, "_blank") },
                            { icon: "unfollow", label: "Unfollow", danger: true, run: () => unfollow(c.id, c.title) },
                          ],
                        })
                      }
                    >
                      <Icon name="more" size={20} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="section-head"><h2>Starter packs</h2></div>
        <div className="page">
          {STARTER_PACKS.map((pack) => {
            const missing = pack.channels.filter((c) => !have.has(c.id));
            return (
              <div key={pack.name} className="pack">
                <span className="name">{pack.name}</span>
                {missing.length ? <button className="btn accent" onClick={() => add(missing)}>Follow {missing.length}</button> : <span className="value" style={{ color: "var(--text-2)" }}>Following</span>}
                <span className="about">{pack.about}</span>
                <span className="stack-avatars">{pack.channels.slice(0, 7).map((c) => <Avatar key={c.id} id={c.id} title={c.title} size={30} />)}</span>
              </div>
            );
          })}
        </div>

        <div className="section-head"><h2>Import from YouTube</h2></div>
        <ol className="steps">
          <li>Open <a href="https://takeout.google.com/" target="_blank" rel="noreferrer">Google Takeout</a>, choose <b>Deselect all</b>, then select <b>YouTube and YouTube Music</b>.</li>
          <li>Under <b>All YouTube data included</b>, keep only <b>subscriptions</b>, then export.</li>
          <li>Choose <b>subscriptions.csv</b> from the download.</li>
        </ol>
        <div className="page" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => takeout.current?.click()}><Icon name="download" size={18} /> Choose subscriptions.csv</button>
        </div>
        <input
          ref={takeout}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const found = parseSubscriptions(await file.text());
            if (found.length) add(found);
            else toast("No channels found in that file");
          }}
        />
      </div>
    </div>
  );
}
