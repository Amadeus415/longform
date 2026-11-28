import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  clearYoutubeCookie,
  judgeFeedVideos,
  refreshDiscover,
  refreshDiscoverStatus,
  saveYoutubeCookie,
  useDiscoverStatus,
} from "../lib/discover";
import {
  applyRules,
  DEFAULT_LLM_PROMPT,
  DEFAULT_RULES,
  describeChanges,
  isDefaultPrompt,
  lookupJudgment,
  normalizeRules,
  type Hidden,
  type LlmJudgeRules,
  type RuleKey,
  type Rules,
} from "../lib/filter";
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
import { summarizeRatings } from "../lib/ratings";
import {
  commitNewsRules,
  commitRules,
  currentNewsRules,
  currentRules,
  markNewsUnread,
  restoreNewsVersion,
  restoreVersion,
  unblockChannel,
  useStore,
} from "../lib/store";
import type { LlmJudgment, Video } from "../lib/types";
import { blendFeed, rankAndDiversifyDiscover, useFeed } from "../lib/useFeed";
import { buildTasteProfile, computePersonalScore } from "../lib/personalize";
import { useNews } from "../lib/useNews";
import { openRatingSheet, RatingsInsightsSheet, scoreTone } from "./Rating";
import { Avatar, Frame, Icon, NewsAvatar, REPO_URL, Segmented, Sheet, Toggle, ago, showActions, toast } from "./ui";

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
  llm: "AI judge",
  blockedChannel: "Hidden channels",
  channelCap: "Per-channel cap",
  discoverCap: "Daily Discover cap",
  pending: "Waiting for AI",
};
const RULE_ORDER: RuleKey[] = [
  "llm",
  "pending",
  "minMinutes",
  "maxMinutes",
  "maxAgeDays",
  "channelCap",
  "discoverCap",
  "hideWords",
  "blockedChannel",
  "hideFinished",
];

const MIN_PRESETS = [0, 2, 3, 5, 10, 20, 30, 60];
const MAX_PRESETS = [0, 60, 120, 180, 240];
const AGE_PRESETS: [number, string][] = [[7, "Week"], [14, "2 weeks"], [30, "Month"], [90, "3 months"], [0, "Any time"]];
const CHANNEL_CAP_PRESETS: [number, string][] = [[0, "Off"], [1, "1"], [2, "2"], [3, "3"], [5, "5"]];
const DISCOVER_LIMIT_PRESETS: [number, string][] = [[3, "3"], [6, "6"], [10, "10"], [15, "15"]];
const BUDGET_PRESETS: [number, string][] = [[0, "Off"], [30, "30m"], [60, "1h"], [90, "90m"], [120, "2h"]];
const SCORE_PRESETS: [number, string][] = [
  [4, "4/10"],
  [5, "5/10"],
  [6, "6/10"],
  [7, "7/10"],
  [8, "8/10"],
];

const minutesLabel = (m: number) => (m === 0 ? "Off" : m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${m}m`);

type VideoSheet =
  | { kind: "hidden"; rule?: RuleKey }
  | { kind: "diff" }
  | { kind: "json" }
  | { kind: "audit" }
  | { kind: "ratings" }
  | { kind: "cookie" }
  | { kind: "blocked" };

function VideoAlgorithm({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const history = useStore((s) => s.history);
  const blockedChannels = useStore((s) => s.blockedChannels);
  const ratings = useStore((s) => s.ratings);
  const ratingsSummary = useMemo(() => summarizeRatings(ratings), [ratings]);
  const saved = currentRules({ history } as never);
  const latest = history[history.length - 1];
  const [draft, setDraft] = useState<Rules>(saved);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [sheet, setSheet] = useState<VideoSheet | null>(null);
  const [focus, setFocus] = useState<RuleKey | "shown" | null>(null);
  const discoverStatus = useDiscoverStatus();

  useEffect(() => {
    refreshDiscoverStatus().catch(() => {});
  }, []);

  const [seenVersion, setSeenVersion] = useState(latest.v);
  if (seenVersion !== latest.v) {
    setSeenVersion(latest.v);
    setDraft(saved);
  }

  const { all, followingAll, discoverAll, followingCount, discoverCount, finishedIds, blockedIds, blockedNames, judgmentsMap, channelsCount, discover } = useFeedBasics();
  const tasteProfile = useMemo(() => buildTasteProfile(ratings), [ratings]);
  const now = Date.now();

  const simulateFeed = (ruleSet: Rules, allowCanonicalFallback = false) => {
    const ctx = {
      now,
      finished: finishedIds,
      judgments: judgmentsMap,
      blockedChannels: blockedIds,
      blockedChannelNames: blockedNames,
      ratings,
      tasteProfile,
      judgeAvailable: discoverStatus.judgeAvailable,
      failClosedDiscover: true,
      allowCanonicalFallback,
    };
    const fRes = applyRules(followingAll, ruleSet, ctx);
    const dPool = ruleSet.discoverEnabled ? discoverAll : [];
    const dRes = applyRules(dPool, ruleSet, ctx);
    const personalMap = Object.fromEntries(
      dRes.shown
        .map((v) => {
          const j = lookupJudgment(v.id, ruleSet, judgmentsMap, allowCanonicalFallback);
          return j ? ([v.id, computePersonalScore(v, j, tasteProfile, ratings[v.id])] as const) : null;
        })
        .filter((x): x is readonly [string, ReturnType<typeof computePersonalScore>] => x !== null),
    );
    const dRanked = rankAndDiversifyDiscover(dRes.shown, ruleSet, judgmentsMap, personalMap, { allowCanonicalFallback });
    return {
      shown: blendFeed(fRes.shown, dRanked.shown),
      hidden: [...fRes.hidden, ...dRes.hidden, ...dRanked.overflow, ...fRes.pending, ...dRes.pending],
      pending: [...fRes.pending, ...dRes.pending],
      channelOverflow: fRes.channelOverflow,
    };
  };

  const promptEdited = draft.llm.prompt.trim() !== saved.llm.prompt.trim();
  const before = useMemo(
    () => simulateFeed(saved, false),
    [followingAll, discoverAll, saved, finishedIds, judgmentsMap, blockedIds, blockedNames, ratings, tasteProfile, discoverStatus.judgeAvailable],
  );
  const after = useMemo(
    () => simulateFeed(draft, promptEdited),
    [followingAll, discoverAll, draft, promptEdited, finishedIds, judgmentsMap, blockedIds, blockedNames, ratings, tasteProfile, discoverStatus.judgeAvailable],
  );
  const changes = useMemo(() => describeChanges(saved, draft), [saved, draft]);
  const edit = (patch: Partial<Rules>) => setDraft((d) => ({ ...d, ...patch }));
  const editLlm = (patch: Partial<LlmJudgeRules>) => setDraft((d) => ({ ...d, llm: { ...d.llm, ...patch } }));

  const editing = changes.length > 0;
  useEffect(() => {
    document.documentElement.classList.toggle("has-draft", editing);
    return () => document.documentElement.classList.remove("has-draft");
  }, [editing]);

  const counts = new Map<RuleKey, number>();
  for (const h of after.hidden) counts.set(h.rule, (counts.get(h.rule) ?? 0) + 1);
  const total = after.shown.length + after.hidden.length;

  const scoredVideos = useMemo(() => {
    const out: { video: Video; judgment: LlmJudgment; blocked: boolean; reason?: string }[] = [];
    const hiddenById = new Map(after.hidden.map((h) => [h.video.id, h]));
    for (const video of all) {
      const judgment = lookupJudgment(video.id, draft, judgmentsMap);
      if (!judgment) continue;
      const hid = hiddenById.get(video.id);
      out.push({ video, judgment, blocked: hid?.rule === "llm", reason: hid?.reason });
    }
    return out;
  }, [all, draft, judgmentsMap, after.hidden]);

  const save = () => {
    if (commitRules(draft, note)) {
      setNote("");
      setNoting(false);
      setSheet(null);
      toast(`Saved as v${latest.v + 1}`);
      if (draft.discoverEnabled && !saved.discoverEnabled) refreshDiscover(true).catch(() => {});
      if (draft.llm.enabled) judgeFeedVideos(all, draft).catch(() => {});
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
            <span className="of">
              of {total} videos ({followingCount} from {channelsCount} channels
              {discoverCount > 0 ? ` + ${discoverCount} recommended` : ""})
            </span>
          </div>
          <div className={`stack${focus ? " focus" : ""}`} role="img" aria-label={`${after.shown.length} shown, ${after.hidden.length} hidden`}>
            {after.shown.length > 0 && <span className={`shown${focus === "shown" ? " focused" : ""}`} style={{ flexGrow: after.shown.length }} />}
            {RULE_ORDER.filter((r) => counts.get(r)).map((r) => (
              <span key={r} className={`${r === "llm" ? "llm " : ""}${focus === r ? "focused" : ""}`} style={{ flexGrow: counts.get(r) }} />
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
                  <span className={`sw${r === "llm" ? " llm" : ""}`} /><span className="lbl">{RULE_LABELS[r]}</span><span className="num">{counts.get(r)}</span>
                  <Icon name="right" size={16} />
                </button>
              </li>
            ))}
          </ul>
          {scoredVideos.length > 0 && (
            <button className="funnel-audit-btn" onClick={() => setSheet({ kind: "audit" })}>
              <span>Inspect AI judge scores ({scoredVideos.length} scored)</span>
              <Icon name="right" size={16} />
            </button>
          )}
          <p className="funnel-foot">
            Shorts and live streams are never fetched. Deterministic rules run first ($0); Gemini scores Discover candidates once on the server, and your 1–10 ratings personalize scores on-device.
          </p>
        </section>

        <div className="section-head"><h2>Your Ratings &amp; Feed Data</h2></div>
        <div className="group">
          <button className="row with-icon" onClick={() => setSheet({ kind: "ratings" })}>
            <span className="lead"><Icon name={ratingsSummary.count ? "starFill" : "star"} /></span>
            <span className="label">
              {ratingsSummary.count > 0
                ? `${ratingsSummary.count} rated · avg ${ratingsSummary.avgScore.toFixed(1)}/10`
                : "Rate videos 1–10 to personalize your feed"}
              <small>
                {ratingsSummary.count > 0
                  ? ratingsSummary.aiAlignment.meanAbsError !== null
                    ? `Active on-device taste model · AI avg diff ±${ratingsSummary.aiAlignment.meanAbsError.toFixed(1)} · CSV & JSON export`
                    : `Active on-device taste model · ${ratingsSummary.highCount} favorites · ${ratingsSummary.lowCount} misses`
                  : "Instantly adjusts scores on-device via channel & category affinity (zero extra API cost)"}
              </small>
            </span>
            <span className="value">{ratingsSummary.count > 0 ? "Insights" : "Open"}</span>
            <span className="chev"><Icon name="right" size={18} /></span>
          </button>
        </div>

        <div className="section-head"><h2>Daily Discover Edition</h2></div>
        <div className="group">
          <div className="rule-block inline">
            <div className="head"><b>Blend daily recommendations</b></div>
            <Toggle checked={draft.discoverEnabled} onChange={(discoverEnabled) => edit({ discoverEnabled })} label="Blend daily recommendations" />
          </div>
          {draft.discoverEnabled && (
            <>
              <PresetRule
                label="Daily Discover cap (max 1/channel)"
                value={`${draft.discoverLimit} videos`}
                presets={DISCOVER_LIMIT_PRESETS}
                current={draft.discoverLimit}
                onPick={(discoverLimit) => edit({ discoverLimit })}
              />
              <button className="row" onClick={() => setSheet({ kind: "cookie" })}>
                <span className="label">
                  Recommendation source
                  <small>
                    {discoverStatus.hasCookie
                      ? `Connected to YouTube Home (${discoverStatus.cookieSource === "env" ? "server env" : "encrypted cookie"})`
                      : "Using YouTube Watch-Next graph (no login needed)"}
                    {discover?.fallbackReason ? ` · ${discover.fallbackReason}` : ""}
                  </small>
                </span>
                <span className="value">{discoverStatus.hasCookie ? "Manage" : "Connect Home"}</span>
                <span className="chev"><Icon name="right" size={18} /></span>
              </button>
            </>
          )}
          {blockedChannels.length > 0 && (
            <button className="row" onClick={() => setSheet({ kind: "blocked" })}>
              <span className="label">
                Hidden channels
                <small>{blockedChannels.length} {blockedChannels.length === 1 ? "channel" : "channels"} muted from recommendations</small>
              </span>
              <span className="chev"><Icon name="right" size={18} /></span>
            </button>
          )}
        </div>

        <div className="section-head"><h2>AI Educational Judge</h2></div>
        <div className="group">
          <div className="judge-status">
            <span>
              <span className={discoverStatus.judgeAvailable ? "dot-ok" : "dot-warn"} />
              {discoverStatus.judgeAvailable === true
                ? `Gemini active · ${discoverStatus.judgeModel}${discoverStatus.judgeBudgetRemaining !== null ? ` · ${discoverStatus.judgeBudgetRemaining.toLocaleString()} left today` : ""}`
                : discoverStatus.judgeAvailable === false
                  ? `Set GEMINI_API_KEY on server (${discoverStatus.judgeModel})`
                  : `Checking Gemini status (${discoverStatus.judgeModel})…`}
            </span>
            {discoverStatus.judgeAvailable && (
              <button
                className="link"
                disabled={discoverStatus.judging}
                onClick={() => {
                  judgeFeedVideos(all, draft, true).then(() => toast("Finished scoring feed"));
                }}
              >
                {discoverStatus.judging ? "Judging…" : "Re-judge"}
              </button>
            )}
          </div>
          {discoverStatus.judgeError && (
            <p className="group-note" style={{ margin: "0 16px 10px", color: "var(--danger)", fontSize: 13 }}>
              {discoverStatus.judgeError}
            </p>
          )}
          <div className="rule-block inline">
            <div className="head"><b>Vet videos with AI judge</b></div>
            <Toggle checked={draft.llm.enabled} onChange={(enabled) => editLlm({ enabled })} label="Vet videos with AI judge" />
          </div>
          {draft.llm.enabled && (
            <>
              <div className="rule-block inline">
                <div className="head"><b>Apply AI judge to</b></div>
                <Segmented
                  value={draft.llm.scope}
                  options={[["discover", "Discover only"], ["all", "All videos"]]}
                  onChange={(scope) => editLlm({ scope })}
                />
              </div>
              <PresetRule
                label="Minimum educational score"
                value={`${draft.llm.minScore}/10`}
                presets={SCORE_PRESETS}
                current={draft.llm.minScore}
                onPick={(minScore) => editLlm({ minScore })}
              />
              <div className="rule-block inline">
                <div className="head"><b>Always block brainrot & clickbait</b></div>
                <Toggle checked={draft.llm.hideBrainrot} onChange={(hideBrainrot) => editLlm({ hideBrainrot })} label="Always block brainrot and clickbait" />
              </div>
              <div className="rule-block">
                <div className="head">
                  <b>Judge instructions</b>
                  {!isDefaultPrompt(draft.llm.prompt) && (
                    <button className="link" style={{ fontSize: 13 }} onClick={() => editLlm({ prompt: DEFAULT_LLM_PROMPT })}>
                      Reset default
                    </button>
                  )}
                </div>
                <textarea
                  className="prompt-edit"
                  value={draft.llm.prompt}
                  onChange={(e) => editLlm({ prompt: e.target.value })}
                  placeholder="Describe what educational content to keep and what brainrot/slop to block..."
                  data-nodrag
                />
                {promptEdited && (
                  <p style={{ margin: "6px 0 0", color: "var(--text-2)", fontSize: 12 }}>
                    Custom rubric scores are computed privately for your account after you save (preview uses existing canonical scores).
                  </p>
                )}
              </div>
            </>
          )}
        </div>
        <p className="group-note" style={{ margin: "8px 28px 0", color: "var(--text-2)", fontSize: 13 }}>
          The default rubric is scored once per video on the server and shared safely across all users. Your 1–10 ratings adjust scores on-device instantly without extra API calls.
        </p>

        <div className="section-head"><h2>Calm Feed &amp; Deterministic Rules</h2></div>
        <div className="group">
          <PresetRule label="Shortest video" value={minutesLabel(draft.minMinutes)} presets={MIN_PRESETS.map((m) => [m, minutesLabel(m)])} current={draft.minMinutes} onPick={(minMinutes) => edit({ minMinutes })} />
          <PresetRule label="Longest video" value={minutesLabel(draft.maxMinutes)} presets={MAX_PRESETS.map((m) => [m, minutesLabel(m)])} current={draft.maxMinutes} onPick={(maxMinutes) => edit({ maxMinutes })} />
          <PresetRule label="Published within" value={AGE_PRESETS.find(([d]) => d === draft.maxAgeDays)?.[1] ?? `${draft.maxAgeDays} days`} presets={AGE_PRESETS} current={draft.maxAgeDays} onPick={(maxAgeDays) => edit({ maxAgeDays })} />
          <PresetRule label="Max per followed channel" value={draft.maxPerChannel ? `${draft.maxPerChannel} videos` : "Off"} presets={CHANNEL_CAP_PRESETS} current={draft.maxPerChannel} onPick={(maxPerChannel) => edit({ maxPerChannel })} />
          <PresetRule label="Daily listening budget" value={minutesLabel(draft.dailyBudgetMinutes)} presets={BUDGET_PRESETS} current={draft.dailyBudgetMinutes} onPick={(dailyBudgetMinutes) => edit({ dailyBudgetMinutes })} />
          <div className="rule-block inline">
            <div className="head"><b>Hide videos I’ve finished</b></div>
            <Toggle checked={draft.hideFinished} onChange={(hideFinished) => edit({ hideFinished })} label="Hide videos I’ve finished" />
          </div>
        </div>
        <p className="group-note" style={{ margin: "8px 28px 0", color: "var(--text-2)", fontSize: 13 }}>
          Defaults (3m min, 30 days, 2 per channel) keep your feed genuinely finite while letting concise 4–19 min educational explainers through.
        </p>

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
      {sheet?.kind === "audit" && <JudgeAuditSheet items={scoredVideos} onClose={() => setSheet(null)} />}
      {sheet?.kind === "ratings" && (
        <RatingsInsightsSheet
          onClose={() => setSheet(null)}
          canRejudge={Boolean(discoverStatus.judgeAvailable && draft.llm.enabled && all.length > 0)}
          judging={discoverStatus.judging}
          onRejudge={() => {
            judgeFeedVideos(all, draft, false).then(() => toast("Refreshed AI scores (your ratings personalize scores instantly on-device)"));
          }}
        />
      )}
      {sheet?.kind === "cookie" && (
        <CookieSheet
          hasCookie={discoverStatus.hasCookie}
          cookieSource={discoverStatus.cookieSource}
          canSaveCookie={discoverStatus.canSaveCookie}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "blocked" && <BlockedChannelsSheet onClose={() => setSheet(null)} />}
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
  const { all, followingAll, discoverAll, discover } = useFeed();
  const progress = useStore((s) => s.progress);
  const channelsCount = useStore((s) => s.channels.length);
  const blockedChannels = useStore((s) => s.blockedChannels);
  const judgmentsMap = useStore((s) => s.judgments);
  const finishedIds = useMemo(() => new Set(Object.values(progress).filter((p) => p.done).map((p) => p.video.id)), [progress]);
  const blockedIds = useMemo(() => new Set(blockedChannels.map((c) => c.id)), [blockedChannels]);
  const blockedNames = useMemo(
    () => new Set(blockedChannels.map((c) => c.title.trim().toLowerCase()).filter(Boolean)),
    [blockedChannels],
  );
  return {
    all,
    followingAll,
    discoverAll,
    followingCount: followingAll.length,
    discoverCount: discoverAll.length,
    finishedIds,
    blockedIds,
    blockedNames,
    judgmentsMap,
    channelsCount,
    discover,
  };
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

function JudgeAuditSheet({
  items,
  onClose,
}: {
  items: { video: Video; judgment: LlmJudgment; blocked: boolean; reason?: string }[];
  onClose: () => void;
}) {
  const ratings = useStore((s) => s.ratings);
  const [view, setView] = useState<"blocked" | "kept">("blocked");
  const blocked = items.filter((i) => i.blocked).sort((a, b) => a.judgment.score - b.judgment.score);
  const kept = items.filter((i) => !i.blocked).sort((a, b) => b.judgment.score - a.judgment.score);
  const list = view === "blocked" ? blocked : kept;

  return (
    <Sheet onClose={onClose} label="AI judge decisions" full>
      <div className="sheet-title"><h2>AI judge decisions</h2></div>
      <div className="page" style={{ marginBottom: 10 }}>
        <Segmented
          value={view}
          options={[
            ["blocked", `Blocked (${blocked.length})`],
            ["kept", `Kept (${kept.length})`],
          ]}
          onChange={setView}
        />
      </div>
      <p className="group-note" style={{ margin: "0 16px 8px", color: "var(--text-2)", fontSize: 13 }}>
        Tap any video to play it anyway, or tap the star to rate it 1–10 and calibrate future AI scores.
      </p>
      {!list.length ? (
        <p className="empty">{view === "blocked" ? "Gemini hasn’t blocked any videos under your current rules." : "No scored videos kept yet."}</p>
      ) : (
        list.map(({ video, judgment }) => {
          const rating = ratings[video.id];
          return (
            <div key={video.id} className="compact rated-row">
              <button className="compact-play" onClick={() => (onClose(), play(video))}>
                <div className="media"><Frame id={video.id} size="medium" /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{video.title}</div>
                  <div className="s">{video.channel} · {video.source === "discover" ? "Discover" : "Following"} · {ago(video.published)}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4, alignItems: "center" }}>
                    {rating && (
                      <span className={`rate-pill-mini tone-${scoreTone(rating.score)}`}>You {rating.score}/10</span>
                    )}
                    <span className={`ai-chip${view === "blocked" || judgment.brainrot ? " bad" : ""}`}>
                      AI {judgment.score}/10{judgment.brainrot ? " · Brainrot" : judgment.category ? ` · ${judgment.category}` : ""}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-2)" }}>{judgment.reason}</span>
                  </div>
                </div>
              </button>
              <button
                className="icon-btn"
                onClick={() => openRatingSheet(video, judgment)}
                aria-label={rating ? `Edit rating (${rating.score}/10)` : `Rate ${video.title}`}
              >
                <Icon name={rating ? "starFill" : "star"} size={18} />
              </button>
            </div>
          );
        })
      )}
    </Sheet>
  );
}

function CookieSheet({
  hasCookie,
  cookieSource,
  canSaveCookie,
  onClose,
}: {
  hasCookie: boolean;
  cookieSource: "user" | "env" | "none";
  canSaveCookie: boolean;
  onClose: () => void;
}) {
  const [cookie, setCookie] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    const res = await saveYoutubeCookie(cookie);
    setSaving(false);
    if (!res.ok) {
      setError(res.error || "Could not save cookie.");
      return;
    }
    toast("Connected to YouTube Home");
    onClose();
  };

  return (
    <Sheet onClose={onClose} label="Connect YouTube Home">
      <div className="sheet-title"><h2>YouTube Home feed</h2></div>
      <div className="page" style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0, color: "var(--text-2)", fontSize: 14, lineHeight: 1.45 }}>
          Without a cookie, Longform uses YouTube’s public <b>Watch-Next</b> graph seeded from your channels and watch history.
          Optionally connect your YouTube cookie to pull directly from your personal YouTube Home feed (still filtered for Shorts, brainrot, and your AI rubric).
        </p>

        {hasCookie && (
          <div className="group" style={{ margin: 0 }}>
            <div className="row static">
              <span className="label">
                Connected
                <small>
                  {cookieSource === "env"
                    ? "Configured via server environment variable (YOUTUBE_COOKIE / YTDLP_COOKIES_B64)"
                    : "Encrypted at rest (AES-256-GCM) on your private server and never sent back to the browser"}
                </small>
              </span>
              {cookieSource === "user" && (
                <button
                  className="btn"
                  onClick={async () => {
                    await clearYoutubeCookie();
                    toast("Disconnected YouTube Home");
                    onClose();
                  }}
                >
                  Disconnect
                </button>
              )}
            </div>
          </div>
        )}

        {canSaveCookie ? (
          <>
            <textarea
              className="json-edit"
              style={{ width: "100%", margin: 0, minHeight: 120 }}
              value={cookie}
              onChange={(e) => (setCookie(e.target.value), setError(null))}
              placeholder="Paste YouTube Cookie header (SID=...; HSID=...) or Netscape cookies.txt"
              spellCheck={false}
              data-nodrag
            />
            {error && <p style={{ margin: 0, color: "var(--danger)", fontSize: 13 }}>{error}</p>}
            <button className="btn accent big" disabled={saving || !cookie.trim()} onClick={onSave}>
              {saving ? "Connecting…" : hasCookie ? "Update YouTube cookie" : "Connect YouTube Home"}
            </button>
          </>
        ) : (
          <p style={{ margin: 0, color: "var(--text-2)", fontSize: 13 }}>
            Per-user YouTube cookies are disabled on public multi-user servers to protect your Google account. Watch-Next recommendations work with zero login; private self-hosts can also set <code>YOUTUBE_COOKIE</code> or <code>ALLOW_USER_YOUTUBE_COOKIES=true</code>.
          </p>
        )}
      </div>
    </Sheet>
  );
}

function BlockedChannelsSheet({ onClose }: { onClose: () => void }) {
  const blocked = useStore((s) => s.blockedChannels);
  return (
    <Sheet onClose={onClose} label="Hidden channels">
      <div className="sheet-title"><h2>Hidden channels</h2></div>
      {!blocked.length ? (
        <p className="empty">No hidden channels.</p>
      ) : (
        <div className="group">
          {blocked.map((c) => (
            <div key={c.id} className="row static with-avatar">
              <Avatar id={c.id} title={c.title} size={40} />
              <span className="label">{c.title}</span>
              <button
                className="link"
                onClick={() => {
                  unblockChannel(c.id);
                  toast(`Restored ${c.title}`);
                }}
              >
                Unblock
              </button>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
