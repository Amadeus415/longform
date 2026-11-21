import { useMemo } from "react";
import { applyRules, type Rules } from "./filter";
import { currentRules, useStore, type Progress } from "./store";
import type { Video } from "./types";

/** Everything the screens need to know about the feed, derived from the store by the filter. */
export function useFeed(rulesOverride?: Rules) {
  const { feeds, channels, progress, history } = useStore();
  const rules = rulesOverride ?? currentRules({ history } as never);

  const all = useMemo(() => {
    const subscribed = new Set(channels.map((c) => c.id));
    return Object.values(feeds).filter((f) => subscribed.has(f.id)).flatMap((f) => f.videos);
  }, [feeds, channels]);

  const finished = useMemo(
    () => new Set(Object.values(progress).filter((p) => p.done).map((p) => p.video.id)),
    [progress],
  );

  const result = useMemo(() => applyRules(all, rules, { now: Date.now(), finished }), [all, rules, finished]);

  const continuing: Progress[] = useMemo(
    () => Object.values(progress).filter((p) => !p.done && p.t > 30).sort((a, b) => b.at - a.at).slice(0, 3),
    [progress],
  );

  return { all, rules, ...result, continuing, progress };
}

export function toVideo(p: Progress): Video {
  return { ...p.video, seconds: p.video.seconds ?? p.d };
}
