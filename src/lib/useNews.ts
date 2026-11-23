import { useMemo } from "react";
import { buildDailyBrief } from "./brief";
import { applyNewsRules } from "./newsFilter";
import { currentNewsRules, useStore } from "./store";

/** Everything News and Algorithm need from the store, computed once per change. */
export function useNews() {
  const sources = useStore((s) => s.newsSources);
  const feeds = useStore((s) => s.newsFeeds);
  const read = useStore((s) => s.newsRead);
  const history = useStore((s) => s.newsHistory);
  const rules = currentNewsRules({ newsHistory: history } as never);

  const all = useMemo(() => {
    const allowed = new Set(sources.map((s) => s.id));
    return Object.values(feeds)
      .filter((f) => allowed.has(f.id))
      .flatMap((f) => f.items);
  }, [sources, feeds]);

  const readIds = useMemo(() => new Set(Object.keys(read)), [read]);

  const { shown, hidden } = useMemo(() => applyNewsRules(all, rules, { now: Date.now(), read: readIds }), [all, rules, readIds]);

  const brief = useMemo(() => buildDailyBrief(shown), [shown]);

  return { all, shown, hidden, brief, read, readIds, rules };
}
