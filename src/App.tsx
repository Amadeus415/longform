import { useCallback, useEffect, useState } from "react";
import {
  apiFetch,
  clearAuthTokens,
  getServerUrl,
  initApi,
  needsServerConfig,
  onUnauthorized,
  setAuthTokens,
} from "./lib/api";
import { refreshFeeds } from "./lib/feed";
import { navigate, tabOf, useRoute } from "./lib/nav";
import {
  closeAuthBrowser,
  hideSplashScreen,
  isNative,
  onAppStateChange,
  onDeepLink,
  syncStatusBar,
} from "./lib/native";
import { refreshNews } from "./lib/newsFeed";
import { restore } from "./lib/player";
import { getState, useStore } from "./lib/store";
import { flushPendingSync, pullAndSync, startCloudSync, stopCloudSync } from "./lib/sync";
import { Algorithm } from "./views/Algorithm";
import { Channels } from "./views/Channels";
import { Feed } from "./views/Feed";
import { Library } from "./views/Library";
import { Lock } from "./views/Lock";
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

type AuthState = {
  checking: boolean;
  needsServer: boolean;
  serverUrl: string;
  protected: boolean;
  authenticated: boolean;
  syncEnabled: boolean;
  email?: string;
  name?: string;
  authError?: string | null;
  methods: { google: boolean; password: boolean };
};

export function App() {
  const route = useRoute();
  const theme = useStore((s) => s.settings.theme);
  const channelCount = useStore((s) => s.channels.length);
  const newsSourceCount = useStore((s) => s.newsSources.length);
  const [auth, setAuth] = useState<AuthState>({
    checking: true,
    needsServer: false,
    serverUrl: "",
    protected: false,
    authenticated: true,
    syncEnabled: false,
    methods: { google: false, password: false },
  });

  const refreshAuth = useCallback(async () => {
    await initApi();
    const currentServer = getServerUrl();
    if (needsServerConfig()) {
      setAuth({
        checking: false,
        needsServer: true,
        serverUrl: "",
        protected: true,
        authenticated: false,
        syncEnabled: false,
        methods: { google: false, password: false },
      });
      hideSplashScreen();
      return;
    }

    try {
      const res = await apiFetch("/api/auth/status", { cache: "no-store" });
      const data = res.ok ? await res.json() : { protected: false, authenticated: true };
      if (typeof data.mediaToken === "string") {
        await setAuthTokens({ mediaToken: data.mediaToken });
      }
      setAuth({
        checking: false,
        needsServer: false,
        serverUrl: currentServer,
        protected: Boolean(data.protected),
        authenticated: Boolean(data.authenticated),
        syncEnabled: Boolean(data.syncEnabled),
        email: typeof data.user?.email === "string" ? data.user.email : typeof data.email === "string" ? data.email : undefined,
        name: typeof data.user?.name === "string" ? data.user.name : undefined,
        authError: null,
        methods: { google: Boolean(data.methods?.google), password: Boolean(data.methods?.password) },
      });
    } catch {
      if (isNative()) {
        setAuth({
          checking: false,
          needsServer: true,
          serverUrl: currentServer,
          protected: true,
          authenticated: false,
          syncEnabled: false,
          authError: "Could not reach your Longform server. Check the server address or your connection.",
          methods: { google: false, password: false },
        });
      } else {
        setAuth({
          checking: false,
          needsServer: false,
          serverUrl: currentServer,
          protected: false,
          authenticated: true,
          syncEnabled: false,
          methods: { google: false, password: false },
        });
      }
    } finally {
      hideSplashScreen();
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    syncStatusBar(theme);
  }, [theme]);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  // Native deep link handler for Google OAuth callback (longform://auth/callback?code=...)
  useEffect(() => {
    return onDeepLink(async (rawUrl) => {
      if (!rawUrl.startsWith("longform://auth/callback")) return;
      await closeAuthBrowser();
      try {
        const parsed = new URL(rawUrl);
        const authError = parsed.searchParams.get("authError");
        if (authError) {
          setAuth((a) => ({ ...a, authError }));
          return;
        }
        const code = parsed.searchParams.get("code");
        if (!code) return;
        const res = await apiFetch("/api/auth/native/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (!res.ok) {
          setAuth((a) => ({ ...a, authError: "failed" }));
          return;
        }
        const data = (await res.json()) as { token?: string; mediaToken?: string };
        if (data.token) {
          await setAuthTokens({ token: data.token, mediaToken: data.mediaToken ?? null });
        }
        await refreshAuth();
      } catch {
        setAuth((a) => ({ ...a, authError: "failed" }));
      }
    });
  }, [refreshAuth]);

  // If a session is revoked or expires mid-use, return cleanly to the sign-in screen.
  useEffect(() => {
    return onUnauthorized(async () => {
      stopCloudSync();
      await clearAuthTokens();
      setAuth((a) => (a.protected ? { ...a, authenticated: false, syncEnabled: false, email: undefined, name: undefined } : a));
    });
  }, []);

  // Cloud sync lifecycle when authenticated.
  useEffect(() => {
    if (auth.checking || !auth.authenticated || !auth.syncEnabled) {
      stopCloudSync();
      return;
    }
    startCloudSync();
    return () => stopCloudSync();
  }, [auth.checking, auth.authenticated, auth.syncEnabled]);

  useEffect(() => {
    if (auth.checking || !auth.authenticated || auth.needsServer) return;
    refreshFeeds();
    refreshNews();
    const onForeground = () => {
      refreshFeeds();
      refreshNews();
      if (auth.syncEnabled) pullAndSync().catch(() => {});
    };
    const onVisible = () => {
      if (document.hidden) flushPendingSync();
      else onForeground();
    };
    const onPageHide = () => flushPendingSync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onPageHide);
    const stopNativeLifecycle = onAppStateChange((isActive) => {
      if (isActive) onForeground();
      else flushPendingSync();
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onPageHide);
      stopNativeLifecycle();
    };
  }, [channelCount, newsSourceCount, auth.checking, auth.authenticated, auth.needsServer, auth.syncEnabled]);

  // Reopen with the last unfinished episode in the mini-player, paused.
  useEffect(() => {
    const { progress, feeds } = getState();
    const last = Object.values(progress).filter((p) => !p.done && p.t > 30).sort((a, b) => b.at - a.at)[0];
    if (!last) return;
    const full = feeds[last.video.channelId]?.videos.find((v) => v.id === last.video.id);
    restore(full ?? { ...last.video, seconds: last.video.seconds ?? last.d }, last.t, last.d);
  }, []);

  if (auth.checking) return null;

  if (auth.needsServer || (auth.protected && !auth.authenticated)) {
    return (
      <>
        <Lock
          methods={auth.methods}
          needsServer={auth.needsServer}
          serverUrl={auth.serverUrl}
          initialError={auth.authError}
          onServerConnected={refreshAuth}
          onUnlocked={refreshAuth}
        />
        <Toasts />
      </>
    );
  }

  if (!channelCount && !newsSourceCount && route === "feed") {
    return (
      <>
        <Onboarding />
        <Toasts />
      </>
    );
  }

  const signOut = async () => {
    stopCloudSync();
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    await clearAuthTokens();
    setAuth((a) => ({ ...a, authenticated: false, syncEnabled: false, email: undefined, name: undefined }));
  };

  const changeServer = () => {
    stopCloudSync();
    setAuth((a) => ({ ...a, needsServer: true }));
  };

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
        {route === "library" && (
          <Library
            authProtected={auth.protected}
            authEmail={auth.email}
            authName={auth.name}
            syncEnabled={auth.syncEnabled}
            serverUrl={auth.serverUrl}
            onSignOut={signOut}
            onChangeServer={isNative() ? changeServer : undefined}
          />
        )}
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
