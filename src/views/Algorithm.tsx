import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { applyRules, describeChanges, DEFAULT_RULES, normalizeRules, type Hidden, type RuleKey, type Rules } from "../lib/filter";
import { intent } from "../lib/nav";
import {
  applyNewsRules,
  DEFAULT_NEWS_RULES,
  describeNewsChanges,
  hoursLabel,
  normalizeNewsRules,
  type HiddenNews,
  type NewsRuleKey,
  type NewsRules,
} from "../lib/newsFilter";
import { play } from "../lib/player";
import {
  commitNewsRules,
  commitRules,
  currentNewsRules,
  currentRules,
  markNewsUnread,
  restoreNewsVersion,
  restoreVersion,
  useStore,
} from "../lib/store";
import { useFeed } from "../lib/useFeed";
import { useNews } from "../lib/useNews";
import { Frame, Icon, NewsAvatar, REPO_URL, Segmented, Sheet, Toggle, ago, showActions, toast } from "./ui";

type Tab = "videos" | "news";

export function Algorithm() {
  const [tab, setTab] = useState<Tab>(() => {
    const initial = intent.algorithmTab ?? "videos";
    intent.algorithmTab = undefined;
    return initial;
  });

  useEffect(() => {
    if (intent.algorithmTab) {
      setTab(intent.algorithmTab);
      intent.algorithmTab = undefined;
    }
  }, []);

  return tab === "news" ? <NewsAlgorithm tab={tab} onTab={setTab} /> : <VideoAlgorithm tab={tab} onTab={setTab} />;
}

// ---------- Videos algorithm ----------

const RULE_LABELS: Record<RuleKey, string> = {
  minMinutes: "Too short",
  maxMinutes: "Too long",
  maxAgeDays: "Too old",
  hideWords: "Hidden words",
  allowWords: "Always shown",
  hideFinished: "Finished",
};
const RULE_ORDER: RuleKey[] = ["minMinutes", "maxMinutes", "maxAgeDays", "hideWords", "hideFinished"];

const MIN_PRESETS = [0, 10, 20, 30, 45, 60, 90];
const MAX_PRESETS = [0, 60, 120, 180, 240];
const AGE_PRESETS: [number, string][] = [[0, "Any time"], [7, "Week"], [30, "Month"], [90, "3 months"], [365, "Year"]];

const minutesLabel = (m: number) => (m === 0 ? "Off" : m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${m}m`);

function VideoAlgorithm({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const history = useStore((s) => s.history);
  const saved = currentRules({ history } as never);
  const latest = history[history.length - 1];
  const [draft, setDraft] = useState<Rules>(saved);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [sheet, setSheet] = useState<null | { kind: "hidden"; rule?: RuleKey } | { kind: "diff" } | { kind: "json" }>(null);
  const [focus, setFocus] = useState<RuleKey | "shown" | null>(null);

  const [seenVersion, setSeenVersion] = useState(latest.v);
  if (seenVersion !== latest.v) {
    setSeenVersion(latest.v);
    setDraft(saved);
  }

  const { all, finishedIds, channelsCount } = useFeedBasics();
  const now = Date.now();
  const before = useMemo(() => applyRules(all, saved, { now, finished: finishedIds }), [all, saved, finishedIds]);
  const after = useMemo(() => applyRules(all, draft, { now, finished: finishedIds }), [all, draft, finishedIds]);
  const changes = useMemo(() => describeChanges(saved, draft), [saved, draft]);
  const edit = (patch: Partial<Rules>) => setDraft((d) => ({ ...d, ...patch }));

  const editing = changes.length > 0;
  useEffect(() => {
    document.documentElement.classList.toggle("has-draft", editing);
    return () => document.documentElement.classList.remove("has-draft");
  }, [editing]);

  const counts = new Map<RuleKey, number>();
  for (const h of after.hidden) counts.set(h.rule, (counts.get(h.rule) ?? 0) + 1);
  const total = after.shown.length + after.hidden.length;

  const save = () => {
    if (commitRules(draft, note)) {
      setNote("");
      setNoting(false);
      setSheet(null);
      toast(`Saved as v${latest.v + 1}`);
    }
  };

  const more = () =>
    showActions({
      title: "Video algorithm",
      actions: [
        { icon: "code", label: "Edit as JSON", run: () => setSheet({ kind: "json" }) },
        { icon: "external", label: "Read the code behind it", run: () => window.open(`${REPO_URL}/blob/main/src/lib/filter.ts`, "_blank") },
        { icon: "restore", label: "Start from default rules", run: () => setDraft(DEFAULT_RULES) },
      ],
    });

  return (
    <div className="view">
      <div className="narrow">
        <header className="large-title">
          <div>
            <h1>Algorithm</h1>
            <p className="subtitle">Videos v{latest.v}, saved {ago(new Date(latest.at).toISOString()).toLowerCase()}</p>
          </div>
          <button className="icon-btn" onClick={more} aria-label="More"><Icon name="more" /></button>
        </header>

        <div className="page" style={{ marginTop: 8 }}>
          <Segmented value={tab} options={[["videos", "Videos"], ["news", "News"]]} onChange={onTab} />
        </div>

        <section className="funnel" aria-label="What your rules do">
          <div className="funnel-head">
            <span className="big">{after.shown.length}</span>
            <span className="of">of {total} videos from {channelsCount} channels make your feed</span>
          </div>
          <div className={`stack${focus ? " focus" : ""}`} role="img" aria-label={`${after.shown.length} shown, ${after.hidden.length} hidden`}>
            {after.shown.length > 0 && <span className={`shown${focus === "shown" ? " focused" : ""}`} style={{ flexGrow: after.shown.length }} />}
            {RULE_ORDER.filter((r) => counts.get(r)).map((r) => (
              <span key={r} className={focus === r ? "focused" : ""} style={{ flexGrow: counts.get(r) }} />
            ))}
          </div>
          <ul className="legend">
            <li>
              <button onPointerEnter={() => setFocus("shown")} onPointerLeave={() => setFocus(null)} onClick={() => setFocus(focus === "shown" ? null : "shown")}>
                <span className="sw shown" /><span className="lbl">In your feed</span><span className="num">{after.shown.length}</span>
              </button>
            </li>
            {RULE_ORDER.filter((r) => counts.get(r)).map((r) => (
              <li key={r}>
                <button onPointerEnter={() => setFocus(r)} onPointerLeave={() => setFocus(null)} onClick={() => setSheet({ kind: "hidden", rule: r })}>
                  <span className="sw" /><span className="lbl">{RULE_LABELS[r]}</span><span className="num">{counts.get(r)}</span>
                  <Icon name="right" size={16} />
                </button>
              </li>
            ))}
          </ul>
          <p className="funnel-foot">Shorts and live streams are never fetched. Everything else is shown newest first unless a rule hides it.</p>
        </section>

        <div className="section-head"><h2>Rules</h2></div>
        <div className="group">
          <PresetRule label="Shortest video" value={minutesLabel(draft.minMinutes)} presets={MIN_PRESETS.map((m) => [m, minutesLabel(m)])} current={draft.minMinutes} onPick={(minMinutes) => edit({ minMinutes })} />
          <PresetRule label="Longest video" value={minutesLabel(draft.maxMinutes)} presets={MAX_PRESETS.map((m) => [m, minutesLabel(m)])} current={draft.maxMinutes} onPick={(maxMinutes) => edit({ maxMinutes })} />
          <PresetRule label="Published within" value={AGE_PRESETS.find(([d]) => d === draft.maxAgeDays)?.[1] ?? `${draft.maxAgeDays} days`} presets={AGE_PRESETS} current={draft.maxAgeDays} onPick={(maxAgeDays) => edit({ maxAgeDays })} />
          <div className="rule-block inline">
            <div className="head"><b>Hide videos I’ve finished</b></div>
            <Toggle checked={draft.hideFinished} onChange={(hideFinished) => edit({ hideFinished })} label="Hide videos I’ve finished" />
          </div>
        </div>

        <div className="section-head"><h2>Words</h2></div>
        <div className="group">
          <div className="rule-block">
            <div className="head"><b>Hide titles with</b><span>{draft.hideWords.length}</span></div>
            <Words words={draft.hideWords} onChange={(hideWords) => edit({ hideWords })} placeholder="Add a word or phrase" />
          </div>
          <div className="rule-block">
            <div className="head"><b>Unless they also have</b><span>{draft.allowWords.length || ""}</span></div>
            <Words words={draft.allowWords} onChange={(allowWords) => edit({ allowWords })} placeholder="For example: lecture" />
          </div>
        </div>
        <p className="group-note" style={{ margin: "8px 28px 0", color: "var(--text-2)", fontSize: 13 }}>
          Whole words, any case: “clip” hides “Best clip” but not “eclipse”. End with * to match the start of a word.
        </p>

        <div className="section-head"><h2>History</h2></div>
        <ol className="timeline">
          {[...history].reverse().map((h) => (
            <li key={h.v} className={h.v === latest.v ? "current" : ""}>
              <span className="dot" />
              <div className="when">
                <b>v{h.v}</b>
                <span>{new Date(h.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                {h.v === latest.v ? <span className="tag">Current</span> : <button className="restore" onClick={() => (restoreVersion(h.v), toast(`Restored v${h.v} as v${latest.v + 1}`))}>Restore</button>}
              </div>
              <ul className="changes">{h.changes.map((c) => <li key={c}>{c}</li>)}</ul>
              {h.note && <p className="note">“{h.note}”</p>}
            </li>
          ))}
        </ol>
      </div>

      {changes.length > 0 && (
        <div className="savebar glass" role="region" aria-label="Unsaved changes">
          <div className="summary">
            <span>{changes.join(" · ")}</span>
            {!noting && <button className="link" onClick={() => setNoting(true)}>Add note</button>}
          </div>
          {noting && (
            <label className="field">
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change?" />
            </label>
          )}
          <div className="buttons">
            <button className="btn" onClick={() => setDraft(saved)}>Discard</button>
            <button className="delta" onClick={() => setSheet({ kind: "diff" })} aria-label="Preview which videos change">
              {before.shown.length} → <b>{after.shown.length}</b> videos <Icon name="right" size={16} />
            </button>
            <button className="btn accent" onClick={save}>Save v{latest.v + 1}</button>
          </div>
        </div>
      )}

      {sheet?.kind === "hidden" && <HiddenSheet hidden={after.hidden} rule={sheet.rule} onClose={() => setSheet(null)} />}
      {sheet?.kind === "diff" && <DiffSheet before={before} after={after} onClose={() => setSheet(null)} onSave={changes.length ? save : undefined} version={latest.v + 1} />}
      {sheet?.kind === "json" && <JsonSheet rules={draft} normalize={normalizeRules} onApply={(r) => (setDraft(r), setSheet(null))} onClose={() => setSheet(null)} />}
    </div>
  );
}

// ---------- News algorithm ----------

const NEWS_RULE_LABELS: Record<NewsRuleKey, string> = {
  maxAgeHours: "Outside window",
  minChars: "Too short",
  hideReposts: "Reposts",
  hideReplies: "Replies",
  hideWords: "Hidden words",
  allowWords: "Always shown",
  hideRead: "Already read",
};
const NEWS_RULE_ORDER: NewsRuleKey[] = ["maxAgeHours", "hideReposts", "hideReplies", "minChars", "hideWords", "hideRead"];

const WINDOW_PRESETS: [number, string][] = [[12, "12h"], [24, "24h"], [48, "2 days"], [168, "Week"], [0, "Any"]];
const CHARS_PRESETS: [number, string][] = [[0, "Off"], [25, "25"], [40, "40"], [80, "80"], [140, "140"]];

function NewsAlgorithm({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const history = useStore((s) => s.newsHistory);
  const sourcesCount = useStore((s) => s.newsSources.length);
  const saved = currentNewsRules({ newsHistory: history } as never);
  const latest = history[history.length - 1];
  const [draft, setDraft] = useState<NewsRules>(saved);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [sheet, setSheet] = useState<null | { kind: "hidden"; rule?: NewsRuleKey } | { kind: "diff" } | { kind: "json" }>(null);
  const [focus, setFocus] = useState<NewsRuleKey | "shown" | null>(null);

  const [seenVersion, setSeenVersion] = useState(latest.v);
  if (seenVersion !== latest.v) {
    setSeenVersion(latest.v);
    setDraft(saved);
  }

  const { all, readIds } = useNews();
  const now = Date.now();
  const before = useMemo(() => applyNewsRules(all, saved, { now, read: readIds }), [all, saved, readIds]);
  const after = useMemo(() => applyNewsRules(all, draft, { now, read: readIds }), [all, draft, readIds]);
  const changes = useMemo(() => describeNewsChanges(saved, draft), [saved, draft]);
  const edit = (patch: Partial<NewsRules>) => setDraft((d) => ({ ...d, ...patch }));

  const editing = changes.length > 0;
  useEffect(() => {
    document.documentElement.classList.toggle("has-draft", editing);
    return () => document.documentElement.classList.remove("has-draft");
  }, [editing]);

  const counts = new Map<NewsRuleKey, number>();
  for (const h of after.hidden) counts.set(h.rule, (counts.get(h.rule) ?? 0) + 1);
  const total = after.shown.length + after.hidden.length;

  const save = () => {
    if (commitNewsRules(draft, note)) {
      setNote("");
      setNoting(false);
      setSheet(null);
      toast(`Saved news rules as v${latest.v + 1}`);
    }
  };

  const more = () =>
    showActions({
      title: "News algorithm",
      actions: [
        { icon: "code", label: "Edit as JSON", run: () => setSheet({ kind: "json" }) },
        { icon: "restore", label: "Start from default rules", run: () => setDraft(DEFAULT_NEWS_RULES) },
      ],
    });

  return (
    <div className="view">
      <div className="narrow">
        <header className="large-title">
          <div>
            <h1>Algorithm</h1>
            <p className="subtitle">News v{latest.v}, saved {ago(new Date(latest.at).toISOString()).toLowerCase()}</p>
          </div>
          <button className="icon-btn" onClick={more} aria-label="More"><Icon name="more" /></button>
        </header>

        <div className="page" style={{ marginTop: 8 }}>
          <Segmented value={tab} options={[["videos", "Videos"], ["news", "News"]]} onChange={onTab} />
        </div>

        <section className="funnel" aria-label="What your news rules do">
          <div className="funnel-head">
            <span className="big">{after.shown.length}</span>
            <span className="of">of {total} items from {sourcesCount} sources make your brief</span>
          </div>
          <div className={`stack${focus ? " focus" : ""}`} role="img" aria-label={`${after.shown.length} shown, ${after.hidden.length} hidden`}>
            {after.shown.length > 0 && <span className={`shown${focus === "shown" ? " focused" : ""}`} style={{ flexGrow: after.shown.length }} />}
            {NEWS_RULE_ORDER.filter((r) => counts.get(r)).map((r) => (
              <span key={r} className={focus === r ? "focused" : ""} style={{ flexGrow: counts.get(r) }} />
            ))}
          </div>
          <ul className="legend">
            <li>
              <button onPointerEnter={() => setFocus("shown")} onPointerLeave={() => setFocus(null)} onClick={() => setFocus(focus === "shown" ? null : "shown")}>
                <span className="sw shown" /><span className="lbl">In your brief</span><span className="num">{after.shown.length}</span>
              </button>
            </li>
            {NEWS_RULE_ORDER.filter((r) => counts.get(r)).map((r) => (
              <li key={r}>
                <button onPointerEnter={() => setFocus(r)} onPointerLeave={() => setFocus(null)} onClick={() => setSheet({ kind: "hidden", rule: r })}>
                  <span className="sw" /><span className="lbl">{NEWS_RULE_LABELS[r]}</span><span className="num">{counts.get(r)}</span>
                  <Icon name="right" size={16} />
                </button>
              </li>
            ))}
          </ul>
          <p className="funnel-foot">No engagement ranking or viral boosts. Multi-source stories cluster automatically into Key Events.</p>
        </section>

        <div className="section-head"><h2>Rules</h2></div>
        <div className="group">
          <PresetRule
            label="Time window"
            value={hoursLabel(draft.maxAgeHours)}
            presets={WINDOW_PRESETS}
            current={draft.maxAgeHours}
            onPick={(maxAgeHours) => edit({ maxAgeHours })}
          />
          <PresetRule
            label="Minimum length (chars)"
            value={draft.minChars ? `${draft.minChars} chars` : "Off"}
            presets={CHARS_PRESETS}
            current={draft.minChars}
            onPick={(minChars) => edit({ minChars })}
          />
          <div className="rule-block inline">
            <div className="head"><b>Hide reposts</b></div>
            <Toggle checked={draft.hideReposts} onChange={(hideReposts) => edit({ hideReposts })} label="Hide reposts" />
          </div>
          <div className="rule-block inline">
            <div className="head"><b>Hide replies</b></div>
            <Toggle checked={draft.hideReplies} onChange={(hideReplies) => edit({ hideReplies })} label="Hide replies" />
          </div>
          <div className="rule-block inline">
            <div className="head"><b>Hide items I’ve read</b></div>
            <Toggle checked={draft.hideRead} onChange={(hideRead) => edit({ hideRead })} label="Hide items I’ve read" />
          </div>
        </div>

        <div className="section-head"><h2>Words</h2></div>
        <div className="group">
          <div className="rule-block">
            <div className="head"><b>Hide posts with</b><span>{draft.hideWords.length}</span></div>
            <Words words={draft.hideWords} onChange={(hideWords) => edit({ hideWords })} placeholder="Add a word or phrase" />
          </div>
          <div className="rule-block">
            <div className="head"><b>Unless they also have</b><span>{draft.allowWords.length || ""}</span></div>
            <Words words={draft.allowWords} onChange={(allowWords) => edit({ allowWords })} placeholder="For example: paper, release" />
          </div>
        </div>

        <div className="section-head"><h2>History</h2></div>
        <ol className="timeline">
          {[...history].reverse().map((h) => (
            <li key={h.v} className={h.v === latest.v ? "current" : ""}>
              <span className="dot" />
              <div className="when">
                <b>v{h.v}</b>
                <span>{new Date(h.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                {h.v === latest.v ? (
                  <span className="tag">Current</span>
                ) : (
                  <button className="restore" onClick={() => (restoreNewsVersion(h.v), toast(`Restored v${h.v} as v${latest.v + 1}`))}>Restore</button>
                )}
              </div>
              <ul className="changes">{h.changes.map((c) => <li key={c}>{c}</li>)}</ul>
              {h.note && <p className="note">“{h.note}”</p>}
            </li>
          ))}
        </ol>
      </div>

      {changes.length > 0 && (
        <div className="savebar glass" role="region" aria-label="Unsaved changes">
          <div className="summary">
            <span>{changes.join(" · ")}</span>
            {!noting && <button className="link" onClick={() => setNoting(true)}>Add note</button>}
          </div>
          {noting && (
            <label className="field">
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change?" />
            </label>
          )}
          <div className="buttons">
            <button className="btn" onClick={() => setDraft(saved)}>Discard</button>
            <button className="delta" onClick={() => setSheet({ kind: "diff" })} aria-label="Preview which items change">
              {before.shown.length} → <b>{after.shown.length}</b> items <Icon name="right" size={16} />
            </button>
            <button className="btn accent" onClick={save}>Save v{latest.v + 1}</button>
          </div>
        </div>
      )}

      {sheet?.kind === "hidden" && <HiddenNewsSheet hidden={after.hidden} rule={sheet.rule} onClose={() => setSheet(null)} />}
      {sheet?.kind === "diff" && <DiffNewsSheet before={before} after={after} onClose={() => setSheet(null)} onSave={changes.length ? save : undefined} version={latest.v + 1} />}
      {sheet?.kind === "json" && <JsonSheet rules={draft} normalize={normalizeNewsRules} onApply={(r) => (setDraft(r), setSheet(null))} onClose={() => setSheet(null)} />}
    </div>
  );
}

// ---------- Shared helpers ----------

function useFeedBasics() {
  const { all } = useFeed();
  const progress = useStore((s) => s.progress);
  const channelsCount = useStore((s) => s.channels.length);
  const finishedIds = useMemo(() => new Set(Object.values(progress).filter((p) => p.done).map((p) => p.video.id)), [progress]);
  return { all, finishedIds, channelsCount };
}

function PresetRule({ label, value, presets, current, onPick }: { label: string; value: string; presets: [number, string][]; current: number; onPick: (n: number) => void }) {
  const custom = !presets.some(([n]) => n === current);
  return (
    <div className="rule-block">
      <div className="head"><b>{label}</b><span>{value}</span></div>
      <div className="chips" role="radiogroup" aria-label={label}>
        {custom && <button className="chip small on" role="radio" aria-checked>{value}</button>}
        {presets.map(([n, text]) => (
          <button key={n} className={`chip small press${n === current ? " on" : ""}`} role="radio" aria-checked={n === current} onClick={() => onPick(n)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Words({ words, onChange, placeholder }: { words: string[]; onChange: (w: string[]) => void; placeholder: string }) {
  const [text, setText] = useState("");
  const add = () => {
    const fresh = text.split(",").map((w) => w.trim()).filter((w) => w && !words.includes(w));
    if (fresh.length) onChange([...words, ...fresh]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    }
  };
  return (
    <>
      {words.length > 0 && (
        <div className="words">
          {words.map((w) => (
            <button key={w} className="word press" onClick={() => onChange(words.filter((x) => x !== w))} aria-label={`Remove ${w}`}>
              {w} <Icon name="close" size={14} />
            </button>
          ))}
        </div>
      )}
      <label className="field word-input">
        <Icon name="plus" size={18} />
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={add} placeholder={placeholder} enterKeyHint="done" autoCapitalize="off" />
      </label>
    </>
  );
}

function HiddenSheet({ hidden, rule, onClose }: { hidden: Hidden[]; rule?: RuleKey; onClose: () => void }) {
  const [only, setOnly] = useState<RuleKey | undefined>(rule);
  const rules = [...new Set(hidden.map((h) => h.rule))];
  const list = only ? hidden.filter((h) => h.rule === only) : hidden;
  return (
    <Sheet onClose={onClose} label="Hidden videos" full>
      <div className="sheet-title"><h2>Hidden by your rules</h2></div>
      {rules.length > 1 && (
        <div className="chips">
          <button className={`chip small${only ? "" : " on"}`} onClick={() => setOnly(undefined)}>All {hidden.length}</button>
          {rules.map((r) => (
            <button key={r} className={`chip small${only === r ? " on" : ""}`} onClick={() => setOnly(r)}>
              {RULE_LABELS[r]} {hidden.filter((h) => h.rule === r).length}
            </button>
          ))}
        </div>
      )}
      <p className="group-note" style={{ margin: "0 16px 8px", color: "var(--text-2)", fontSize: 13 }}>Tap a video to play it anyway.</p>
      {list.map(({ video, reason }) => (
        <button key={video.id} className="compact" onClick={() => (onClose(), play(video))}>
          <div className="media"><Frame id={video.id} size="medium" /></div>
          <div style={{ minWidth: 0 }}>
            <div className="t">{video.title}</div>
            <div className="s">{video.channel} · {ago(video.published)}</div>
            <span className="why"><Icon name="eyeOff" size={13} /> {reason}</span>
          </div>
        </button>
      ))}
    </Sheet>
  );
}

function HiddenNewsSheet({ hidden, rule, onClose }: { hidden: HiddenNews[]; rule?: NewsRuleKey; onClose: () => void }) {
  const [only, setOnly] = useState<NewsRuleKey | undefined>(rule);
  const rules = [...new Set(hidden.map((h) => h.rule))];
  const list = only ? hidden.filter((h) => h.rule === only) : hidden;
  return (
    <Sheet onClose={onClose} label="Hidden news items" full>
      <div className="sheet-title"><h2>Hidden by your news rules</h2></div>
      {rules.length > 1 && (
        <div className="chips">
          <button className={`chip small${only ? "" : " on"}`} onClick={() => setOnly(undefined)}>All {hidden.length}</button>
          {rules.map((r) => (
            <button key={r} className={`chip small${only === r ? " on" : ""}`} onClick={() => setOnly(r)}>
              {NEWS_RULE_LABELS[r]} {hidden.filter((h) => h.rule === r).length}
            </button>
          ))}
        </div>
      )}
      <p className="group-note" style={{ margin: "0 16px 8px", color: "var(--text-2)", fontSize: 13 }}>Tap any item to open it anyway.</p>
      {list.map(({ item, rule: itemRule, reason }) => (
        <div key={item.id} className="compact news-compact">
          <NewsAvatar id={item.sourceId} title={item.sourceTitle} size={34} />
          <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ minWidth: 0, flex: 1 }}>
            <div className="t">{item.title}</div>
            <div className="s">{item.sourceTitle} · {ago(item.published)}</div>
            <span className="why"><Icon name="eyeOff" size={13} /> {reason}</span>
          </a>
          {itemRule === "hideRead" && (
            <button className="link" style={{ fontSize: 13 }} onClick={() => markNewsUnread([item.id])}>Unread</button>
          )}
        </div>
      ))}
    </Sheet>
  );
}

function DiffSheet({ before, after, onClose, onSave, version }: { before: ReturnType<typeof applyRules>; after: ReturnType<typeof applyRules>; onClose: () => void; onSave?: () => void; version: number }) {
  const wasShown = new Set(before.shown.map((v) => v.id));
  const isShown = new Set(after.shown.map((v) => v.id));
  const nowHidden = after.hidden.filter((h) => wasShown.has(h.video.id));
  const nowShown = after.shown.filter((v) => !wasShown.has(v.id));
  return (
    <Sheet onClose={onClose} label="What changes" full>
      <div className="sheet-title">
        <h2>What this change does</h2>
        {onSave && <button className="btn accent" onClick={onSave}>Save v{version}</button>}
      </div>
      {!nowHidden.length && !nowShown.length && <p className="empty">Your feed stays exactly the same.</p>}
      {nowShown.length > 0 && <div className="search-section">Added to your feed · {nowShown.length}</div>}
      {nowShown.map((v) => (
        <div key={v.id} className="compact">
          <div className="media"><Frame id={v.id} size="medium" /></div>
          <div style={{ minWidth: 0 }}>
            <div className="t">{v.title}</div>
            <div className="s">{v.channel}</div>
            <span className="why added"><Icon name="plus" size={13} /> Will show</span>
          </div>
        </div>
      ))}
      {nowHidden.length > 0 && <div className="search-section">Removed from your feed · {nowHidden.length}</div>}
      {nowHidden.filter((h) => !isShown.has(h.video.id)).map(({ video, reason }) => (
        <div key={video.id} className="compact">
          <div className="media"><Frame id={video.id} size="medium" /></div>
          <div style={{ minWidth: 0 }}>
            <div className="t">{video.title}</div>
            <div className="s">{video.channel}</div>
            <span className="why"><Icon name="eyeOff" size={13} /> {reason}</span>
          </div>
        </div>
      ))}
    </Sheet>
  );
}

function DiffNewsSheet({
  before,
  after,
  onClose,
  onSave,
  version,
}: {
  before: ReturnType<typeof applyNewsRules>;
  after: ReturnType<typeof applyNewsRules>;
  onClose: () => void;
  onSave?: () => void;
  version: number;
}) {
  const wasShown = new Set(before.shown.map((i) => i.id));
  const isShown = new Set(after.shown.map((i) => i.id));
  const nowHidden = after.hidden.filter((h) => wasShown.has(h.item.id));
  const nowShown = after.shown.filter((i) => !wasShown.has(i.id));
  return (
    <Sheet onClose={onClose} label="What changes" full>
      <div className="sheet-title">
        <h2>What this change does</h2>
        {onSave && <button className="btn accent" onClick={onSave}>Save v{version}</button>}
      </div>
      {!nowHidden.length && !nowShown.length && <p className="empty">Your brief stays exactly the same.</p>}
      {nowShown.length > 0 && <div className="search-section">Added to your brief · {nowShown.length}</div>}
      {nowShown.map((i) => (
        <div key={i.id} className="compact news-compact">
          <NewsAvatar id={i.sourceId} title={i.sourceTitle} size={34} />
          <div style={{ minWidth: 0 }}>
            <div className="t">{i.title}</div>
            <div className="s">{i.sourceTitle}</div>
            <span className="why added"><Icon name="plus" size={13} /> Will show</span>
          </div>
        </div>
      ))}
      {nowHidden.length > 0 && <div className="search-section">Removed from your brief · {nowHidden.length}</div>}
      {nowHidden.filter((h) => !isShown.has(h.item.id)).map(({ item, reason }) => (
        <div key={item.id} className="compact news-compact">
          <NewsAvatar id={item.sourceId} title={item.sourceTitle} size={34} />
          <div style={{ minWidth: 0 }}>
            <div className="t">{item.title}</div>
            <div className="s">{item.sourceTitle}</div>
            <span className="why"><Icon name="eyeOff" size={13} /> {reason}</span>
          </div>
        </div>
      ))}
    </Sheet>
  );
}

function JsonSheet<T>({ rules, normalize, onApply, onClose }: { rules: T; normalize: (raw: unknown) => T; onApply: (r: T) => void; onClose: () => void }) {
  const [text, setText] = useState(JSON.stringify(rules, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet onClose={onClose} label="Edit as JSON" full>
      <div className="sheet-title">
        <h2>Edit as JSON</h2>
        <button
          className="btn accent"
          onClick={() => {
            try {
              onApply(normalize(JSON.parse(text)));
            } catch {
              setError("That isn’t valid JSON yet. Check for a missing comma or quote.");
            }
          }}
        >
          Apply
        </button>
      </div>
      <textarea className="json-edit" value={text} spellCheck={false} onChange={(e) => (setText(e.target.value), setError(null))} data-nodrag />
      {error && <p className="group-note" style={{ margin: "8px 16px", color: "var(--danger)" }}>{error}</p>}
      <p className="group-note" style={{ margin: "8px 16px", color: "var(--text-2)", fontSize: 13 }}>Applying puts these rules in the draft. Nothing changes until you save.</p>
    </Sheet>
  );
}
