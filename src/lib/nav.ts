import { useSyncExternalStore } from "react";

// Three tabs and one sub-page, kept in the URL hash so Back and reloads behave.

export type Route = "feed" | "algorithm" | "library" | "library/channels";
const ROUTES: Route[] = ["feed", "algorithm", "library", "library/channels"];

function read(): Route {
  const hash = location.hash.slice(1) as Route;
  return ROUTES.includes(hash) ? hash : "feed";
}

let route: Route = typeof location === "undefined" ? "feed" : read();
const listeners = new Set<() => void>();
const scrollBy = new Map<Route, number>();

/** Something the next screen should do on arrival, such as searching for a channel name. */
export let intent: { channelQuery?: string } = {};

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    scrollBy.set(route, window.scrollY);
    route = read();
    listeners.forEach((l) => l());
    requestAnimationFrame(() => window.scrollTo(0, scrollBy.get(route) ?? 0));
  });
}

export function useRoute(): Route {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => route);
}

export function navigate(next: Route, nextIntent: typeof intent = {}): void {
  intent = nextIntent;
  if (next === route) {
    window.scrollTo({ top: 0, behavior: "smooth" }); // tapping the current tab scrolls to the top
    return;
  }
  if (next === "library/channels") scrollBy.delete(next);
  location.hash = next === "feed" ? "" : next;
}

export function tabOf(r: Route): "feed" | "algorithm" | "library" {
  return r.startsWith("library") ? "library" : (r as "feed" | "algorithm");
}
