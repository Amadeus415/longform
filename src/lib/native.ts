import { App as CapApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Preferences } from "@capacitor/preferences";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function nativePlatform(): "ios" | "android" | "web" {
  const p = Capacitor.getPlatform();
  return p === "ios" || p === "android" ? p : "web";
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  if (isNative()) {
    try {
      await Browser.open({ url, presentationStyle: "popover" });
      return;
    } catch {}
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function openAuthBrowser(url: string): Promise<void> {
  if (isNative()) {
    await Browser.open({ url, presentationStyle: "fullscreen" });
    return;
  }
  location.href = url;
}

export async function closeAuthBrowser(): Promise<void> {
  if (!isNative()) return;
  try {
    await Browser.close();
  } catch {}
}

export function onDeepLink(handler: (url: string) => void): () => void {
  if (!isNative()) return () => {};
  let removed = false;
  const handlePromise = CapApp.addListener("appUrlOpen", (event) => {
    if (!removed && event.url) handler(event.url);
  });
  return () => {
    removed = true;
    handlePromise.then((h) => h.remove()).catch(() => {});
  };
}

export function onAppStateChange(handler: (isActive: boolean) => void): () => void {
  if (!isNative()) return () => {};
  let removed = false;
  const handlePromise = CapApp.addListener("appStateChange", ({ isActive }) => {
    if (!removed) handler(isActive);
  });
  return () => {
    removed = true;
    handlePromise.then((h) => h.remove()).catch(() => {});
  };
}

export async function syncStatusBar(theme: "auto" | "light" | "dark"): Promise<void> {
  if (!isNative()) return;
  try {
    const prefersDark = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = theme === "dark" || (theme === "auto" && prefersDark);
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch {}
}

export async function hideSplashScreen(): Promise<void> {
  if (!isNative()) return;
  try {
    await SplashScreen.hide();
  } catch {}
}

export function haptic(kind: "light" | "medium" = "light"): void {
  if (!isNative()) return;
  Haptics.impact({ style: kind === "medium" ? ImpactStyle.Medium : ImpactStyle.Light }).catch(() => {});
}

export async function prefGet(key: string): Promise<string | null> {
  if (isNative()) {
    try {
      const { value } = await Preferences.get({ key });
      return value ?? null;
    } catch {}
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function prefSet(key: string, value: string): Promise<void> {
  if (isNative()) {
    try {
      await Preferences.set({ key, value });
      return;
    } catch {}
  }
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export async function prefRemove(key: string): Promise<void> {
  if (isNative()) {
    try {
      await Preferences.remove({ key });
      return;
    } catch {}
  }
  try {
    localStorage.removeItem(key);
  } catch {}
}
