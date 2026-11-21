import { useEffect, useState } from "react";
import { refreshFeeds, useFeedStatus } from "./lib/feed";
import { useStore } from "./lib/store";
import { useFeed } from "./lib/useFeed";
import { Algorithm, type Tab } from "./views/Algorithm";
import { Channels } from "./views/Channels";
import { Feed } from "./views/Feed";
import { MiniPlayer, PlayerSheet } from "./views/Player";
import { Icon } from "./views/ui";

type View = "feed" | "channels";

function useHashView(): [View, (v: View) => void] {
  const read = (): View => (location.hash === "#channels" ? "channels" : "feed");
  const [view, setView] = useState<View>(read);
  useEffect(() => {
    const onHash = () => {
      setView(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [view, (v) => (location.hash = v === "feed" ? "" : v)];
}

export function App() {
  const [view, go] = useHashView();
  const [sheet, setSheet] = useState<Tab | null>(null);
  const { channels, settings } = useStore();

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    refreshFeeds();
    const onVisible = () => !document.hidden && refreshFeeds();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [channels.length]);

  return (
    <>
      <header className="top">
        {view === "feed" ? (
          <>
            <a className="wordmark" href="#" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Longform</a>
            {channels.length > 0 && <FilterPill onClick={() => setSheet("rules")} />}
            <button className="text-button" onClick={() => go("channels")}>Channels</button>
          </>
        ) : (
          <>
            <button className="text-button back" onClick={() => go("feed")}><Icon name="left" size={20} /> Feed</button>
            <span className="top-title">Channels & settings</span>
            <span className="spacer" />
          </>
        )}
      </header>

      <main>
        {view === "feed" ? (
          <Feed onShowHidden={() => setSheet("hidden")} onChannels={() => go("channels")} />
        ) : (
          <Channels onRules={() => setSheet("rules")} />
        )}
      </main>

      <MiniPlayer />
      <PlayerSheet />
      {sheet && <Algorithm tab={sheet} onTab={setSheet} onClose={() => setSheet(null)} />}
    </>
  );
}

function FilterPill({ onClick }: { onClick: () => void }) {
  const { rules, hidden } = useFeed();
  const status = useFeedStatus();
  const parts = [rules.minMinutes ? `${rules.minMinutes}m+` : "any length"];
  if (rules.maxAgeDays) parts.push(`${rules.maxAgeDays}d`);
  return (
    <button className="pill" onClick={onClick} aria-label="Your algorithm: rules, hidden videos, history">
      {status.pending > 0 && <span className="dot" aria-label="Updating" />}
      {parts.join(" · ")} · {hidden.length} hidden
    </button>
  );
}
