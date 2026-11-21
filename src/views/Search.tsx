import { useMemo, useState } from "react";
import { contains } from "../lib/filter";
import { navigate } from "../lib/nav";
import { play } from "../lib/player";
import { useStore } from "../lib/store";
import { useFeed } from "../lib/useFeed";
import { openVideoActions } from "./actions";
import { Avatar, Frame, Icon, Sheet, ago } from "./ui";

/** Search what's already here: your videos (hidden ones too) and your channels. */
export function Search({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const channels = useStore((s) => s.channels);
  const { all, hidden } = useFeed();
  const hiddenWhy = useMemo(() => new Map(hidden.map((h) => [h.video.id, h.reason])), [hidden]);
  const q = query.trim();

  const videos = useMemo(() => {
    if (!q) return [];
    const words = q.split(/\s+/);
    const seen = new Set<string>();
    return all
      .filter((v) => words.every((w) => contains(`${v.title} ${v.channel}`, `${w}*`)) && !seen.has(v.id) && seen.add(v.id))
      .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
      .slice(0, 40);
  }, [all, q]);
  const matchingChannels = q ? channels.filter((c) => contains(c.title, `${q}*`)) : [];

  return (
    <Sheet onClose={onClose} label="Search" full>
      <div className="search-head">
        <label className="field">
          <Icon name="search" size={20} />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your videos and channels"
            enterKeyHint="search"
            autoCorrect="off"
          />
        </label>
        <button className="cancel" onClick={onClose}>Cancel</button>
      </div>

      {matchingChannels.length > 0 && (
        <>
          <div className="search-section">Channels</div>
          {matchingChannels.map((c) => (
            <div key={c.id} className="row with-avatar static">
              <Avatar id={c.id} title={c.title} size={40} />
              <span className="label">{c.title}</span>
            </div>
          ))}
        </>
      )}

      {videos.length > 0 && <div className="search-section">Videos</div>}
      {videos.map((v) => (
        <div key={v.id} style={{ display: "flex", alignItems: "flex-start" }}>
          <button className="compact" onClick={() => (onClose(), play(v))}>
            <div className="media"><Frame id={v.id} size="medium" /></div>
            <div style={{ minWidth: 0 }}>
              <div className="t">{v.title}</div>
              <div className="s">{v.channel} · {ago(v.published)}</div>
              {hiddenWhy.has(v.id) && <span className="why"><Icon name="eyeOff" size={13} /> {hiddenWhy.get(v.id)}</span>}
            </div>
          </button>
          <button className="icon-btn" onClick={() => openVideoActions(v)} aria-label="More actions"><Icon name="more" size={20} /></button>
        </div>
      ))}

      {q && (
        <button className="row with-icon" onClick={() => (onClose(), navigate("library/channels", { channelQuery: q }))}>
          <span className="lead"><Icon name="plus" /></span>
          <span className="label">Find “{q}” on YouTube<small>Follow a new channel</small></span>
          <span className="chev"><Icon name="right" size={18} /></span>
        </button>
      )}
      {q && !videos.length && !matchingChannels.length && <p className="empty">Nothing in your feed matches “{q}”.</p>}
    </Sheet>
  );
}
