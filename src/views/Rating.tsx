import { useMemo, useState, useSyncExternalStore } from "react";
import { play } from "../lib/player";
import { ratingsToCsv, ratingsToJson, summarizeRatings } from "../lib/ratings";
import { clearVideoRating, rateVideo, useStore } from "../lib/store";
import type { LlmJudgment, Video, VideoRating } from "../lib/types";
import { Frame, Icon, Segmented, Sheet, ago, span, toast } from "./ui";

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function scoreTone(score: number): "high" | "mid" | "low" {
  if (score >= 8) return "high";
  if (score >= 5) return "mid";
  return "low";
}

function scoreHint(score: number | null): string {
  if (score === null) return "Tap a number from 1 (waste of time) to 10 (must-watch)";
  if (score >= 9) return "Exceptional — want much more like this";
  if (score === 8) return "Great — strong fit for my feed";
  if (score >= 6) return "Good — worth keeping around";
  if (score >= 4) return "Meh — borderline / low signal";
  return "Poor — keep this kind of video out of my feed";
}

// ---------- global rating sheet host ----------

type RatingRequest = { video: Video; judgment?: LlmJudgment } | null;
let ratingRequest: RatingRequest = null;
const ratingListeners = new Set<() => void>();

export function openRatingSheet(video: Video, judgment?: LlmJudgment): void {
  ratingRequest = { video, judgment };
  ratingListeners.forEach((l) => l());
}

function closeRatingSheet(): void {
  ratingRequest = null;
  ratingListeners.forEach((l) => l());
}

export function RatingHost() {
  const req = useSyncExternalStore(
    (l) => (ratingListeners.add(l), () => ratingListeners.delete(l)),
    () => ratingRequest,
  );
  if (!req) return null;
  return <RatingSheet video={req.video} judgment={req.judgment} onClose={closeRatingSheet} />;
}

function RatingSheet({ video, judgment, onClose }: { video: Video; judgment?: LlmJudgment; onClose: () => void }) {
  const existing = useStore((s) => s.ratings[video.id]);
  const [score, setScore] = useState<number | null>(existing?.score ?? null);
  const [note, setNote] = useState(existing?.note ?? "");

  const aiScore = judgment?.score ?? existing?.aiScore;
  const aiCategory = judgment?.category ?? existing?.aiCategory;
  const aiReason = judgment?.reason ?? existing?.aiReason;

  const commit = (nextScore: number, closeAfter = false) => {
    setScore(nextScore);
    rateVideo(video, nextScore, { note, judgment });
    toast(`Rated ${nextScore}/10`);
    if (closeAfter) onClose();
  };

  const saveAll = () => {
    if (score === null) return;
    rateVideo(video, score, { note, judgment });
    toast(`Saved ${score}/10`);
    onClose();
  };

  const remove = () => {
    clearVideoRating(video.id);
    toast("Rating removed");
    onClose();
  };

  return (
    <Sheet onClose={onClose} label={`Rate ${video.title}`} className="rating-sheet">
      <div className="actions-head">
        <div className="actions-title">{video.title}</div>
        <div className="actions-subtitle">
          {video.channel}
          {video.seconds ? ` · ${span(video.seconds)}` : ""}
          {aiScore !== undefined ? ` · AI ${aiScore}/10${aiCategory ? ` (${aiCategory})` : ""}` : ""}
        </div>
        {aiReason && <div className="rating-ai-why">AI note: {aiReason}</div>}
      </div>

      <div className="page" style={{ display: "grid", gap: 12 }}>
        <div className="rating-grid" role="radiogroup" aria-label="Rate this video from 1 to 10">
          {SCORES.map((n) => {
            const on = score === n;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={on}
                className={`rating-btn press tone-${scoreTone(n)}${on ? " on" : ""}`}
                onClick={() => commit(n, false)}
              >
                {n}
              </button>
            );
          })}
        </div>

        <p className="rating-hint">{scoreHint(score)}</p>

        <label className="field rating-note-field">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && score !== null) {
                e.preventDefault();
                saveAll();
              }
            }}
            placeholder="Optional note (e.g. great depth, too clickbaity…)"
            maxLength={280}
            data-nodrag
          />
        </label>

        <div className="rating-sheet-actions">
          {existing && (
            <button type="button" className="btn danger-text" onClick={remove}>
              Clear
            </button>
          )}
          <button
            type="button"
            className="btn accent"
            style={{ flex: 1 }}
            disabled={score === null}
            onClick={saveAll}
          >
            {score === null ? "Pick a score 1–10" : existing ? `Done (${score}/10)` : `Save ${score}/10`}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------- compact inline 1-10 bar (used inside Player) ----------

export function InlineRatingBar({ video, judgment }: { video: Video; judgment?: LlmJudgment }) {
  const existing = useStore((s) => s.ratings[video.id]);
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(existing?.note ?? "");
  const [seenId, setSeenId] = useState(video.id);

  if (seenId !== video.id) {
    setSeenId(video.id);
    setEditingNote(false);
    setNote(existing?.note ?? "");
  }

  const pick = (n: number) => {
    rateVideo(video, n, { judgment });
    toast(`Rated ${n}/10`);
  };

  const saveNote = () => {
    if (!existing) return;
    rateVideo(video, existing.score, { note, judgment });
    setEditingNote(false);
    toast(note.trim() ? "Note saved" : "Note cleared");
  };

  const aiScore = judgment?.score ?? existing?.aiScore;

  return (
    <div className="player-rating" data-nodrag>
      <div className="player-rating-head">
        <span className="player-rating-label">
          <Icon name={existing ? "starFill" : "star"} size={14} />
          {existing ? `Your rating: ${existing.score}/10` : "Rate this video (1–10)"}
          {aiScore !== undefined && <span className="player-rating-ai"> · AI {aiScore}/10</span>}
        </span>
        {existing && (
          <div className="player-rating-links">
            <button
              type="button"
              onClick={() => {
                setNote(existing.note ?? "");
                setEditingNote((v) => !v);
              }}
            >
              {existing.note ? "Edit note" : "Add note"}
            </button>
            <button
              type="button"
              onClick={() => {
                clearVideoRating(video.id);
                setEditingNote(false);
                setNote("");
                toast("Rating removed");
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="rating-grid compact-grid" role="radiogroup" aria-label="Rate this video from 1 to 10">
        {SCORES.map((n) => {
          const on = existing?.score === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={on}
              className={`rating-btn press tone-${scoreTone(n)}${on ? " on" : ""}`}
              onClick={() => pick(n)}
            >
              {n}
            </button>
          );
        })}
      </div>

      {existing?.note && !editingNote && <p className="player-rating-note">“{existing.note}”</p>}

      {editingNote && existing && (
        <div className="player-rating-note-row">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveNote();
              }
            }}
            placeholder="Why this score?"
            maxLength={280}
          />
          <button type="button" onClick={saveNote}>Save</button>
        </div>
      )}
    </div>
  );
}

// ---------- Ratings & Feed Insights Sheet ----------

type ListFilter = "all" | "high" | "low" | "diff";

function downloadFile(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  Object.assign(document.createElement("a"), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ratingToVideo(r: VideoRating): Video {
  return {
    id: r.videoId,
    title: r.title,
    channel: r.channel,
    channelId: r.channelId,
    published: r.published ?? new Date(r.ratedAt).toISOString(),
    seconds: r.seconds,
    source: r.source,
  };
}

export function RatingsInsightsSheet({
  onClose,
  onRejudge,
  canRejudge = false,
  judging = false,
}: {
  onClose: () => void;
  onRejudge?: () => void;
  canRejudge?: boolean;
  judging?: boolean;
}) {
  const ratings = useStore((s) => s.ratings);
  const [filter, setFilter] = useState<ListFilter>("all");
  const summary = useMemo(() => summarizeRatings(ratings), [ratings]);
  const allList = useMemo(() => Object.values(ratings).sort((a, b) => b.ratedAt - a.ratedAt), [ratings]);

  const filteredList = useMemo(() => {
    if (filter === "high") return allList.filter((r) => r.score >= 8);
    if (filter === "low") return allList.filter((r) => r.score <= 4);
    if (filter === "diff") return summary.aiAlignment.disagreements.map((d) => d.rating);
    return allList;
  }, [allList, filter, summary.aiAlignment.disagreements]);

  const peakBucket = Math.max(...summary.distribution, 1);
  const dateTag = new Date().toISOString().slice(0, 10);

  return (
    <Sheet onClose={onClose} label="Your video ratings and feed data" full>
      <div className="sheet-title">
        <h2>Ratings & Feed Data</h2>
        {summary.count > 0 && (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn"
              onClick={() => {
                downloadFile(`longform-ratings-${dateTag}.csv`, ratingsToCsv(ratings), "text/csv;charset=utf-8");
                toast("Exported ratings CSV");
              }}
            >
              CSV
            </button>
            <button
              className="btn"
              onClick={() => {
                downloadFile(`longform-ratings-${dateTag}.json`, ratingsToJson(ratings), "application/json");
                toast("Exported ratings JSON");
              }}
            >
              JSON
            </button>
          </div>
        )}
      </div>

      {summary.count === 0 ? (
        <div className="empty">
          <h3>No ratings yet</h3>
          <p>Tap <b>Rate</b> on any video card or rate 1–10 inside the player. Your ratings help measure feed quality, prioritize Discover seeds, and calibrate the AI judge.</p>
        </div>
      ) : (
        <div className="insights-body">
          <div className="insight-grid">
            <div className="insight-stat">
              <div className="big">{summary.count}</div>
              <div className="cap">Videos rated</div>
            </div>
            <div className="insight-stat">
              <div className="big">{summary.avgScore.toFixed(1)}<small>/10</small></div>
              <div className="cap">Average score</div>
            </div>
            <div className="insight-stat">
              <div className="big">
                {summary.aiAlignment.meanAbsError !== null ? `±${summary.aiAlignment.meanAbsError.toFixed(1)}` : "—"}
              </div>
              <div className="cap">AI avg diff</div>
            </div>
          </div>

          <section className="insight-card">
            <div className="insight-card-head">
              <b>Score distribution (1–10)</b>
              <span>{summary.highCount} high · {summary.midCount} mid · {summary.lowCount} low</span>
            </div>
            <div className="dist-bars" role="img" aria-label={summary.distribution.map((c, i) => `${i + 1}/10: ${c}`).join(", ")}>
              {summary.distribution.map((count, idx) => (
                <div key={idx + 1} className="dist-col">
                  <span className="dist-count">{count || ""}</span>
                  <div className="dist-track">
                    <span
                      className={`dist-bar tone-${scoreTone(idx + 1)}${count === 0 ? " zero" : ""}`}
                      style={{ height: count === 0 ? 3 : `${Math.max(10, (count / peakBucket) * 100)}%` }}
                    />
                  </div>
                  <span className="dist-lbl">{idx + 1}</span>
                </div>
              ))}
            </div>
          </section>

          {(summary.bySource.following.count > 0 || summary.bySource.discover.count > 0) && (
            <section className="insight-card">
              <div className="insight-card-head"><b>Source comparison</b></div>
              <div className="insight-rows">
                {summary.bySource.following.count > 0 && (
                  <div className="insight-row">
                    <span>Following</span>
                    <span>
                      <b>{summary.bySource.following.avgScore?.toFixed(1)}/10</b> ({summary.bySource.following.count})
                    </span>
                  </div>
                )}
                {summary.bySource.discover.count > 0 && (
                  <div className="insight-row">
                    <span>Discover recommendations</span>
                    <span>
                      <b>{summary.bySource.discover.avgScore?.toFixed(1)}/10</b> ({summary.bySource.discover.count})
                    </span>
                  </div>
                )}
                {summary.aiAlignment.pairedCount > 0 && (
                  <div className="insight-row">
                    <span>You vs. AI Judge ({summary.aiAlignment.pairedCount} paired)</span>
                    <span>
                      <b>You {summary.aiAlignment.avgHuman?.toFixed(1)}</b> vs AI {summary.aiAlignment.avgAi?.toFixed(1)}
                      {summary.aiAlignment.bias !== null && Math.abs(summary.aiAlignment.bias) >= 0.3
                        ? ` (${summary.aiAlignment.bias > 0 ? "AI rates higher" : "AI rates lower"})`
                        : ""}
                    </span>
                  </div>
                )}
              </div>
            </section>
          )}

          {summary.byChannel.length > 0 && (
            <section className="insight-card">
              <div className="insight-card-head">
                <b>Channels by your average rating</b>
                <span>{summary.byChannel.length} channels</span>
              </div>
              <div className="insight-rows">
                {summary.byChannel.slice(0, 8).map((ch) => (
                  <div key={ch.key} className="insight-row">
                    <span className="truncate">{ch.label}</span>
                    <span>
                      <span className={`rate-pill-mini tone-${scoreTone(Math.round(ch.avgScore))}`}>
                        {ch.avgScore.toFixed(1)}/10
                      </span>
                      <span className="muted"> · {ch.count}</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(summary.byLength.length > 0 || summary.byCategory.length > 0) && (
            <section className="insight-card">
              <div className="insight-card-head"><b>By length & category</b></div>
              <div className="insight-rows">
                {summary.byLength.map((l) => (
                  <div key={l.key} className="insight-row">
                    <span>{l.label}</span>
                    <span>
                      <b>{l.avgScore.toFixed(1)}/10</b> <span className="muted">({l.count})</span>
                    </span>
                  </div>
                ))}
                {summary.byCategory.slice(0, 6).map((c) => (
                  <div key={c.key} className="insight-row">
                    <span>{c.label}</span>
                    <span>
                      <b>{c.avgScore.toFixed(1)}/10</b>
                      {c.aiAvgScore !== null ? <span className="muted"> · AI {c.aiAvgScore.toFixed(1)}</span> : null}
                      <span className="muted"> ({c.count})</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {canRejudge && onRejudge && (
            <div style={{ padding: "0 16px" }}>
              <button className="btn accent big" disabled={judging} onClick={onRejudge}>
                <Icon name="spark" size={18} />
                {judging ? "Re-judging feed with your taste…" : "Re-judge feed using my ratings"}
              </button>
            </div>
          )}

          <div className="page">
            <Segmented
              value={filter}
              options={[
                ["all", `All (${allList.length})`],
                ["high", `8–10 (${summary.highCount})`],
                ["low", `1–4 (${summary.lowCount})`],
                ["diff", `AI Diff (${summary.aiAlignment.disagreements.length})`],
              ]}
              onChange={setFilter}
            />
          </div>

          {!filteredList.length ? (
            <p className="empty">No rated videos in this filter yet.</p>
          ) : (
            <div>
              {filteredList.map((r) => {
                const video = ratingToVideo(r);
                const delta = typeof r.aiScore === "number" ? r.score - r.aiScore : null;
                return (
                  <div key={r.videoId} className="compact rated-row">
                    <button
                      className="compact-play"
                      onClick={() => {
                        onClose();
                        play(video);
                      }}
                    >
                      <div className="media"><Frame id={r.videoId} size="medium" /></div>
                      <div style={{ minWidth: 0 }}>
                        <div className="t">{r.title || r.videoId}</div>
                        <div className="s">
                          {r.channel}
                          {r.source === "discover" ? " · Discover" : ""}
                          {" · "}Rated {ago(new Date(r.ratedAt).toISOString()).toLowerCase()}
                        </div>
                        <div className="rated-badges">
                          <span className={`rate-pill-mini tone-${scoreTone(r.score)}`}>You {r.score}/10</span>
                          {typeof r.aiScore === "number" && (
                            <span className="ai-chip">
                              AI {r.aiScore}/10{delta !== null && Math.abs(delta) >= 2 ? ` (${delta > 0 ? `+${delta}` : delta})` : ""}
                            </span>
                          )}
                          {r.aiCategory && <span className="muted" style={{ fontSize: 12 }}>{r.aiCategory}</span>}
                        </div>
                        {r.note && <div className="rated-note-preview">“{r.note}”</div>}
                      </div>
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => openRatingSheet(video)}
                      aria-label={`Edit rating for ${r.title}`}
                    >
                      <Icon name="starFill" size={18} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
