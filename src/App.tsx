import { useEffect } from "react";
import { refreshFeeds } from "./lib/feed";
import { navigate, tabOf, useRoute } from "./lib/nav";
import { refreshNews } from "./lib/newsFeed";
import { restore } from "./lib/player";
import { getState, useStore } from "./lib/store";
import { Algorithm } from "./views/Algorithm";
import { Channels } from "./views/Channels";
import { Feed } from "./views/Feed";
import { Library } from "./views/Library";
import { News } from "./views/News";
import { NewsSources } from "./views/NewsSources";
import { Onboarding } from "./views/Onboarding";
import { MiniPlayer, PlayerSheet } from "./views/Player";
import { ActionHost, Icon, Toasts, type IconName } from "./views/ui";

const TABS: { id: "feed" | "news" | "algorithm" | "library"; label: string; icon: IconName; active: IconName }[] = [
  { id: "feed", label: "Videos", icon: "home", active: "homeFill" },
  { id: "news", label: "News", icon: "news", active: "newsFill" },
  { id: "algorithm", label: "Algorithm", icon: "algorithm", active: "algorithm" },
  { id: "library", label: "Library", icon: "you", active: "you" },
];

export function App() {
  const route = useRoute();
  const theme = useStore((s) => s.settings.theme);
  const channelCount = useStore((s) => s.channels.length);
  const newsSourceCount = useStore((s) => s.newsSources.length);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    refreshFeeds();
    refreshNews();
    const onVisible = () => {
      if (!document.hidden) {
        refreshFeeds();
        refreshNews();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [channelCount, newsSourceCount]);

  // Reopen with the last unfinished episode in the mini-player, paused.
  useEffect(() => {
    const { progress, feeds } = getState();
    const last = Object.values(progress).filter((p) => !p.done && p.t > 30).sort((a, b) => b.at - a.at)[0];
    if (!last) return;
    const full = feeds[last.video.channelId]?.videos.find((v) => v.id === last.video.id);
    restore(full ?? { ...last.video, seconds: last.video.seconds ?? last.d }, last.t, last.d);
  }, []);

  if (!channelCount && !newsSourceCount && route === "feed") {
    return (
      <>
        <Onboarding />
        <Toasts />
      </>
    );
  }

  const tab = tabOf(route);
  return (
    <div className="app">
      <nav className="side-rail" aria-label="Sections">
        <a className="brand" href="#" onClick={(e) => (e.preventDefault(), navigate("feed"))}>
          <img className="brand-mark" src="/icons/icon-192.png" alt="" />
          <span className="brand-word">Longform</span>
        </a>
        {TABS.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? " on" : ""}`} onClick={() => navigate(t.id)} aria-current={tab === t.id ? "page" : undefined}>
            <Icon name={tab === t.id ? t.active : t.icon} strong={tab === t.id} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <main>
        {route === "feed" && <Feed />}
        {route === "news" && <News />}
        {route === "algorithm" && <Algorithm />}
        {route === "library" && <Library />}
        {route === "library/channels" && <Channels />}
        {route === "library/sources" && <NewsSources />}
      </main>

      <div className="dock-fade" aria-hidden="true" />
      <MiniPlayer />
      <nav className="tabbar glass" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? " on" : ""}`} onClick={() => navigate(t.id)} aria-current={tab === t.id ? "page" : undefined}>
            <Icon name={tab === t.id ? t.active : t.icon} strong={tab === t.id} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <PlayerSheet />
      <ActionHost />
      <Toasts />
    </div>
  );
}
