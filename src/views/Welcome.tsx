import { refreshFeeds } from "../lib/feed";
import { STARTER_PACKS } from "../lib/starter";
import { addChannels } from "../lib/store";

export function Welcome({ onChannels }: { onChannels: () => void }) {
  return (
    <div className="welcome">
      <h1>Your YouTube, long-form only.</h1>
      <p className="lede">
        No Shorts, no clickbait, no infinite scroll. Just the channels you choose, filtered by rules you can read, change,
        and roll back.
      </p>

      <h2 className="label">Start with a pack</h2>
      <ul className="packs">
        {STARTER_PACKS.map((pack) => (
          <li key={pack.name}>
            <button
              className="pack"
              onClick={() => {
                addChannels(pack.channels);
                refreshFeeds();
              }}
            >
              <span className="pack-name">{pack.name}</span>
              <span className="meta">{pack.channels.map((c) => c.title).join(", ")}</span>
              <span className="pack-add">Add</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="quiet">
        Or <button className="link" onClick={onChannels}>add your own channels</button> and import your YouTube subscriptions.
      </p>
    </div>
  );
}
