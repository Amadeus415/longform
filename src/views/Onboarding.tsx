import { useState } from "react";
import { refreshFeeds } from "../lib/feed";
import { navigate } from "../lib/nav";
import { STARTER_PACKS } from "../lib/starter";
import { addChannels } from "../lib/store";
import { Avatar, Icon } from "./ui";

export function Onboarding() {
  const [picked, setPicked] = useState<Set<string>>(new Set(["Podcasts"]));
  const chosen = STARTER_PACKS.filter((p) => picked.has(p.name));
  const count = new Set(chosen.flatMap((p) => p.channels.map((c) => c.id))).size;

  const toggle = (name: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="onboarding">
      <img className="appicon" src="/icons/icon-512.png" alt="" />
      <h1>Your YouTube, long-form only.</h1>
      <p className="lede">No Shorts and no clickbait. Just the channels you choose, filtered by rules you can read and change. What do you want to learn?</p>

      {STARTER_PACKS.map((pack) => (
        <button key={pack.name} className={`pack press${picked.has(pack.name) ? " selected" : ""}`} onClick={() => toggle(pack.name)} aria-pressed={picked.has(pack.name)}>
          <span className="name">{pack.name}</span>
          <span className="tick"><Icon name="check" size={16} strong /></span>
          <span className="about">{pack.about}</span>
          <span className="stack-avatars">{pack.channels.slice(0, 7).map((c) => <Avatar key={c.id} id={c.id} title={c.title} size={30} />)}</span>
        </button>
      ))}

      <div className="cta">
        <div className="cta-inner">
          <button
            className="btn accent big press"
            disabled={!count}
            onClick={() => {
              addChannels(chosen.flatMap((p) => p.channels));
              refreshFeeds();
            }}
          >
            {count ? `Build my feed from ${count} channels` : "Pick at least one"}
          </button>
          <button className="secondary" onClick={() => navigate("library/channels")}>Choose channels myself or import from YouTube</button>
        </div>
      </div>
    </div>
  );
}
