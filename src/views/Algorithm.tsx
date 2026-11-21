import { useMemo, useState, type KeyboardEvent } from "react";
import { describeChanges, normalizeRules, type RuleKey, type Rules } from "../lib/filter";
import { play } from "../lib/player";
import { commitRules, currentRules, restoreVersion, useStore } from "../lib/store";
import { useFeed } from "../lib/useFeed";
import { Icon, REPO_URL, Segmented, Sheet, ago } from "./ui";

export type Tab = "rules" | "hidden" | "history";

export function Algorithm({ tab, onTab, onClose }: { tab: Tab; onTab: (t: Tab) => void; onClose: () => void }) {
  const store = useStore();
  const { hidden } = useFeed();
  const latest = store.history[store.history.length - 1];

  return (
    <Sheet onClose={onClose} label="Your algorithm" tall>
      <header className="sheet-head">
        <h2>Your algorithm</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>
      <Segmented
        value={tab}
        onChange={onTab}
        options={[["rules", "Rules"], ["hidden", `Hidden · ${hidden.length}`], ["history", `History · v${latest.v}`]]}
      />
      <div className="sheet-body">
        {tab === "rules" && <RulesEditor key={latest.v} saved={currentRules(store)} />}
        {tab === "hidden" && <HiddenList onEditRules={() => onTab("rules")} />}
        {tab === "history" && <History />}
      </div>
    </Sheet>
  );
}

function RulesEditor({ saved }: { saved: Rules }) {
  const [draft, setDraft] = useState<Rules>(saved);
  const [note, setNote] = useState("");
  const [json, setJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const changes = useMemo(() => describeChanges(saved, draft), [saved, draft]);
  const now = useFeed();
  const next = useFeed(draft);
  const { history } = useStore();
  const nextVersion = history[history.length - 1].v + 1;
  const edit = (patch: Partial<Rules>) => setDraft((d) => ({ ...d, ...patch }));

  const apply = () => {
    if (commitRules(draft, note)) setNote("");
  };

  return (
    <div className="rules">
      <p className="quiet">
        Every video from your channels is shown, newest first, unless one of these rules hides it. Nothing else decides
        what you see.
      </p>

      <div className="rule locked">
        <span>Shorts and live streams are never fetched.</span>
      </div>

      <label className="rule">
        <span>Hide videos shorter than</span>
        <NumberInput value={draft.minMinutes} onChange={(minMinutes) => edit({ minMinutes })} />
        <span>min</span>
      </label>
      <label className="rule">
        <span>Hide videos longer than</span>
        <NumberInput value={draft.maxMinutes} onChange={(maxMinutes) => edit({ maxMinutes })} />
        <span>min</span>
      </label>
      <label className="rule">
        <span>Hide videos older than</span>
        <NumberInput value={draft.maxAgeDays} onChange={(maxAgeDays) => edit({ maxAgeDays })} />
        <span>days</span>
      </label>

      <div className="rule column">
        <span>Hide titles containing</span>
        <Words words={draft.hideWords} onChange={(hideWords) => edit({ hideWords })} placeholder="Add word or phrase…" />
      </div>
      <div className="rule column">
        <span>…unless the title also contains</span>
        <Words words={draft.allowWords} onChange={(allowWords) => edit({ allowWords })} placeholder="Add word, e.g. lecture" />
      </div>

      <label className="rule">
        <span className="grow">Hide videos I’ve finished</span>
        <input type="checkbox" className="switch" checked={draft.hideFinished} onChange={(e) => edit({ hideFinished: e.target.checked })} />
      </label>

      <p className="quiet small">
        Words match whole words, ignoring case: “clip” hides “Best clip” but not “eclipse”. End a word with * to match its
        start: “react*” also hides “reaction”. Empty or 0 turns a limit off.
      </p>

      <details className="json" onToggle={(e) => setJson((e.target as HTMLDetailsElement).open ? JSON.stringify(draft, null, 2) : null)}>
        <summary>Edit as JSON</summary>
        {json !== null && (
          <>
            <textarea
              value={json}
              spellCheck={false}
              rows={14}
              onChange={(e) => {
                setJson(e.target.value);
                try {
                  setDraft(normalizeRules(JSON.parse(e.target.value)));
                  setJsonError(null);
                } catch {
                  setJsonError("Not valid JSON yet.");
                }
              }}
            />
            {jsonError && <p className="error small">{jsonError}</p>}
          </>
        )}
      </details>

      <p className="quiet small">
        This is the entire algorithm: <a href={`${REPO_URL}/blob/main/src/lib/filter.ts`} target="_blank" rel="noreferrer">filter.ts</a>.
      </p>

      {changes.length > 0 && (
        <div className="apply">
          <ul className="changes">
            {changes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <p className="small">
            Your feed goes from {now.shown.length} to <b>{next.shown.length}</b> videos.
          </p>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why? (optional, saved in history)" />
          <div className="actions">
            <button className="button primary" onClick={apply}>Save as v{nextVersion}</button>
            <button className="button" onClick={() => setDraft(saved)}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NumberInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <input
      className="number"
      type="number"
      inputMode="numeric"
      min={0}
      value={value || ""}
      placeholder="off"
      onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
    />
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
    } else if (e.key === "Backspace" && !text && words.length) onChange(words.slice(0, -1));
  };
  return (
    <div className="words">
      {words.map((w) => (
        <button key={w} className="chip" onClick={() => onChange(words.filter((x) => x !== w))} aria-label={`Remove ${w}`}>
          {w} <span aria-hidden="true">×</span>
        </button>
      ))}
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={add} placeholder={placeholder} enterKeyHint="done" />
    </div>
  );
}

const RULE_NAMES: Partial<Record<RuleKey, string>> = {
  minMinutes: "Too short",
  maxMinutes: "Too long",
  maxAgeDays: "Too old",
  hideWords: "Words",
  hideFinished: "Finished",
};

function HiddenList({ onEditRules }: { onEditRules: () => void }) {
  const { hidden } = useFeed();
  const [only, setOnly] = useState<RuleKey | null>(null);
  const counts = new Map<RuleKey, number>();
  for (const h of hidden) counts.set(h.rule, (counts.get(h.rule) ?? 0) + 1);
  const list = only ? hidden.filter((h) => h.rule === only) : hidden;

  if (!hidden.length) return <p className="quiet center">Nothing is hidden right now.</p>;

  return (
    <div>
      <p className="quiet small">
        Each video shows the rule that hid it. Tap one to play it anyway, or{" "}
        <button className="link" onClick={onEditRules}>change the rules</button>.
      </p>
      {counts.size > 1 && (
        <div className="words">
          <button className={`chip${only ? "" : " on"}`} onClick={() => setOnly(null)}>All {hidden.length}</button>
          {[...counts].map(([rule, n]) => (
            <button key={rule} className={`chip${only === rule ? " on" : ""}`} onClick={() => setOnly(rule)}>
              {RULE_NAMES[rule] ?? rule} {n}
            </button>
          ))}
        </div>
      )}
      <ul className="list">
        {list.map(({ video, reason }) => (
          <li key={video.id}>
            <button className="row" onClick={() => play(video)} title="Play anyway">
              <div className="row-text">
                <span className="row-title">{video.title}</span>
                <span className="meta">{video.channel} · {ago(video.published)}</span>
                <span className="reason">{reason}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function History() {
  const { history } = useStore();
  const latest = history[history.length - 1].v;
  return (
    <ol className="history">
      {[...history].reverse().map((h) => (
        <li key={h.v}>
          <div className="history-head">
            <b>v{h.v}</b>
            <span className="meta">{new Date(h.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
            {h.v === latest ? (
              <span className="current">current</span>
            ) : (
              <button className="link" onClick={() => restoreVersion(h.v)}>Restore</button>
            )}
          </div>
          <ul className="changes">{h.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          {h.note && <p className="history-note">“{h.note}”</p>}
        </li>
      ))}
    </ol>
  );
}
