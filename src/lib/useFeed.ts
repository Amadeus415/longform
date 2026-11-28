import { useEffect, useMemo } from "react";
import { isJudgeAttemptExhausted, judgeFeedVideos, useDiscoverStatus } from "./discover";
import { applyRules, lookupJudgment, needsLlmJudge, type Hidden, type Rules } from "./filter";
import { buildTasteProfile, computePersonalScore } from "./personalize";
import { currentRules, dayKey, setState, useStore, type Progress } from "./store";
import type { LlmJudgment, PersonalScore, Video } from "./types";

/**
 * Calm feed blending with a HARD ≤ 20% Discover cap in the All feed:
 * - Shows 2 followed videos first, then weaves 1 Discover video after every 4 followed videos.
 * - Never appends a tail of back-to-back Discover videos when Following is small:
 *   caps blended Discover at `floor(following.length / 4)` (or 1 when `following.length >= 2`, 0 when `< 2` if following exists).
 *   Users can always browse the full daily edition on the dedicated Discover tab.
 */
export function blendFeed(following: Video[], discover: Video[]): Video[] {
  if (!discover.length) return following;
  if (!following.length) return discover;

  // Hard cap: at most 1 Discover per 4 followed videos (≤ 20% of blended feed; min 1 when ≥ 2 followed videos).
  const maxDiscover = following.length >= 4
    ? Math.floor(following.length / 4)
    : following.length >= 2
      ? 1
      : 0;
  const cappedDiscover = discover.slice(0, maxDiscover);
  if (!cappedDiscover.length) return following;

  const out: Video[] = [];
  let fi = 0;
  let di = 0;

  for (let k = 0; k < 2 && fi < following.length; k++) out.push(following[fi++]);

  while (fi < following.length) {
    if (di < cappedDiscover.length) out.push(cappedDiscover[di++]);
    for (let k = 0; k < 4 && fi < following.length; k++) {
      out.push(following[fi++]);
    }
  }
  return out;
}

/**
 * Quality-first, diverse Discover ranking:
 * 1. Primary score = personalized AI educational quality (20..200) minus clickbait/ragebait penalties.
 * 2. Minor bounded tie-breaker = YouTube candidate strength (capped at +15 so YouTube's engagement
 *    order NEVER overrides educational quality).
 * 3. Strict 1-video-per-channel diversity cap.
 * 4. Category spacing so back-to-back recommendations cover distinct topics when available.
 * 5. Optional locked edition IDs so finishing/rating one pick NEVER backfills an endless stream!
 */
export function rankAndDiversifyDiscover(
  candidates: Video[],
  rules: Rules,
  judgments: Readonly<Record<string, LlmJudgment>>,
  personalScores: Readonly<Record<string, PersonalScore>>,
  options?: { lockedEditionIds?: string[]; allowCanonicalFallback?: boolean },
): { shown: Video[]; overflow: Hidden[] } {
  const scored = candidates.map((v) => {
    const j = lookupJudgment(v.id, rules, judgments, Boolean(options?.allowCanonicalFallback));
    const p = personalScores[v.id];
    const effective = p?.effectiveScore ?? j?.score ?? 5;
    const cbPenalty = j?.clickbait && j.clickbait >= 6 ? (j.clickbait - 5) * 4 : 0;
    const rbPenalty = j?.ragebait && j.ragebait >= 5 ? (j.ragebait - 4) * 6 : 0;
    const sourceTieBreaker = Math.min(15, Math.max(0, v.recommendedScore ?? 0));
    const rankScore = effective * 20 - cbPenalty - rbPenalty + sourceTieBreaker;
    return { video: v, rankScore, judgment: j, personal: p };
  });

  scored.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    const ta = a.video.published ? Date.parse(a.video.published) || 0 : 0;
    const tb = b.video.published ? Date.parse(b.video.published) || 0 : 0;
    return tb - ta;
  });

  // If today's daily edition is already locked, show ONLY the remaining unfinished picks from that fixed set
  // (respecting `discoverLimit` if user adjusts it), so finishing a video never backfills a 7th pick!
  if (options?.lockedEditionIds?.length) {
    const allowedSet = new Set(options.lockedEditionIds.slice(0, rules.discoverLimit));
    const lockedOrder = new Map(options.lockedEditionIds.map((id, i) => [id, i]));
    const inEdition: typeof scored = [];
    const overflow: Hidden[] = [];
    for (const item of scored) {
      if (allowedSet.has(item.video.id)) {
        inEdition.push(item);
      } else {
        overflow.push({
          video: item.video,
          rule: "discoverCap",
          reason: `Outside today’s fixed ${rules.discoverLimit}-video Discover edition`,
          judgment: item.judgment,
          personal: item.personal,
        });
      }
    }
    inEdition.sort((a, b) => (lockedOrder.get(a.video.id) ?? 999) - (lockedOrder.get(b.video.id) ?? 999));
    return { shown: inEdition.map((x) => x.video), overflow };
  }

  // Enforce max 1 recommended video per channel.
  const seenChannels = new Set<string>();
  const uniqueChannel: typeof scored = [];
  const overflow: Hidden[] = [];

  for (const item of scored) {
    const chKey = item.video.channelId || item.video.channel.trim().toLowerCase() || item.video.id;
    if (seenChannels.has(chKey)) {
      overflow.push({
        video: item.video,
        rule: "channelCap",
        reason: `Only 1 recommendation per channel (${item.video.channel})`,
        judgment: item.judgment,
        personal: item.personal,
      });
      continue;
    }
    seenChannels.add(chKey);
    uniqueChannel.push(item);
  }

  // Greedy category spacing so back-to-back Discover cards vary topics when possible.
  const pool = [...uniqueChannel];
  const ordered: typeof scored = [];
  let lastCategory = "";

  while (pool.length && ordered.length < rules.discoverLimit) {
    let pickIdx = 0;
    if (lastCategory) {
      const diffIdx = pool.findIndex((item) => (item.judgment?.category ?? "").toLowerCase() !== lastCategory);
      if (diffIdx !== -1 && diffIdx <= 4) pickIdx = diffIdx;
    }
    const [picked] = pool.splice(pickIdx, 1);
    ordered.push(picked);
    lastCategory = (picked.judgment?.category ?? "").toLowerCase();
  }

  for (const rest of pool) {
    overflow.push({
      video: rest.video,
      rule: "discoverCap",
      reason: `Outside your daily top ${rules.discoverLimit} Discover picks`,
      judgment: rest.judgment,
      personal: rest.personal,
    });
  }

  return {
    shown: ordered.map((x) => x.video),
    overflow,
  };
}

/** Everything the screens need to know about the feed, derived from the store by the two-stage filter. */
export function useFeed(rulesOverride?: Rules) {
  const { feeds, discover, discoverEdition, judgments, channels, blockedChannels, progress, ratings, history } = useStore();
  const discoverStatus = useDiscoverStatus();
  const rules = rulesOverride ?? currentRules({ history } as never);

  const subscribed = useMemo(() => new Set(channels.map((c) => c.id)), [channels]);
  const subscribedNames = useMemo(
    () => new Set(channels.map((c) => c.title.trim().toLowerCase()).filter(Boolean)),
    [channels],
  );

  const followingAll = useMemo(
    () =>
      Object.values(feeds)
        .filter((f) => subscribed.has(f.id))
        .flatMap((f) => f.videos.map((v) => ({ ...v, source: "following" as const }))),
    [feeds, subscribed],
  );

  const discoverAll = useMemo(() => {
    if (!rules.discoverEnabled || !discover?.videos?.length) return [];
    const seenFollowing = new Set(followingAll.map((v) => v.id));
    return discover.videos
      .filter((v) => {
        if (seenFollowing.has(v.id)) return false;
        if (v.channelId && subscribed.has(v.channelId)) return false;
        if (v.channel && subscribedNames.has(v.channel.trim().toLowerCase())) return false;
        return true;
      })
      .map((v) => ({ ...v, source: "discover" as const }));
  }, [rules.discoverEnabled, discover, followingAll, subscribed, subscribedNames]);

  const all = useMemo(() => [...followingAll, ...discoverAll], [followingAll, discoverAll]);

  const finished = useMemo(
    () => new Set(Object.values(progress).filter((p) => p.done).map((p) => p.video.id)),
    [progress],
  );

  const blockedSet = useMemo(() => new Set(blockedChannels.map((c) => c.id)), [blockedChannels]);
  const blockedNames = useMemo(
    () => new Set(blockedChannels.map((c) => c.title.trim().toLowerCase()).filter(Boolean)),
    [blockedChannels],
  );
  const tasteProfile = useMemo(() => buildTasteProfile(ratings), [ratings]);

  const now = useMemo(() => Date.now(), [all, rules, finished, judgments, blockedSet, ratings]);

  const filterContext = useMemo(
    () => ({
      now,
      finished,
      judgments,
      blockedChannels: blockedSet,
      blockedChannelNames: blockedNames,
      ratings,
      tasteProfile,
      judgeAvailable: discoverStatus.judgeAvailable,
      failClosedDiscover: true,
    }),
    [now, finished, judgments, blockedSet, blockedNames, ratings, tasteProfile, discoverStatus.judgeAvailable],
  );

  const activeJudgments = useMemo(() => {
    const map: Record<string, LlmJudgment> = {};
    for (const v of all) {
      const j = lookupJudgment(v.id, rules, judgments);
      if (j) map[v.id] = j;
    }
    return map;
  }, [all, rules, judgments]);

  const personalScores = useMemo(() => {
    const map: Record<string, PersonalScore> = {};
    for (const v of all) {
      const j = activeJudgments[v.id];
      if (j) map[v.id] = computePersonalScore(v, j, tasteProfile, ratings[v.id]);
    }
    return map;
  }, [all, activeJudgments, tasteProfile, ratings]);

  const followingResult = useMemo(
    () => applyRules(followingAll, rules, filterContext),
    [followingAll, rules, filterContext],
  );

  const followingUncapped = useMemo(
    () =>
      rules.maxPerChannel > 0
        ? applyRules(followingAll, { ...rules, maxPerChannel: 0 }, filterContext).shown
        : followingResult.shown,
    [followingAll, rules, filterContext, followingResult.shown],
  );

  const today = dayKey();
  const syncedLockedIds =
    discoverEdition && discoverEdition.editionDay === today && discoverEdition.lockedIds.length
      ? discoverEdition.lockedIds
      : undefined;
  const effectiveLockedIds = discover?.lockedEditionIds?.length ? discover.lockedEditionIds : syncedLockedIds;

  const discoverResult = useMemo(() => {
    const res = applyRules(discoverAll, rules, filterContext);
    // Always honor today's locked edition IDs once sealed (from local discover or synced across devices),
    // so finishing a pick NEVER backfills an endless stream!
    const hasLocked = !rulesOverride && Boolean(effectiveLockedIds?.length);
    const { shown, overflow } = rankAndDiversifyDiscover(res.shown, rules, judgments, personalScores, {
      lockedEditionIds: hasLocked ? effectiveLockedIds : undefined,
    });
    return {
      shown,
      hidden: [...res.hidden, ...overflow],
      pending: res.pending,
    };
  }, [discoverAll, rules, filterContext, judgments, personalScores, effectiveLockedIds, rulesOverride]);

  // Lock today's daily edition as soon as EITHER:
  // (a) the daily cap is filled (`shown.length >= discoverLimit`), OR
  // (b) all remaining pending candidates are exhausted / judge unavailable / errored / `pending.length === 0`.
  // That guarantees a single blocked/omitted candidate or exhausted quota NEVER disables the finite edition lock!
  useEffect(() => {
    if (rulesOverride || !discover || !rules.discoverEnabled) return;
    if (effectiveLockedIds?.length) return;
    if (discoverResult.shown.length === 0) return;
    const capFilled = discoverResult.shown.length >= rules.discoverLimit;
    const noActivePending =
      discoverResult.pending.length === 0 ||
      discoverStatus.judgeAvailable === false ||
      Boolean(discoverStatus.judgeError) ||
      (!discoverStatus.judging &&
        discoverResult.pending.every((p) => isJudgeAttemptExhausted(p.video.id, rules.llm.prompt)));
    if (!capFilled && !noActivePending) return;
    const ids = discoverResult.shown.map((v) => v.id);
    const editionDay = discover.editionDay ?? today;
    setState((s) =>
      s.discover && s.discover.fetchedAt === discover.fetchedAt && !s.discover.lockedEditionIds?.length
        ? {
            discover: { ...s.discover, lockedEditionIds: ids },
            discoverEdition: { editionDay, lockedIds: ids },
          }
        : {},
    );
  }, [
    rulesOverride,
    discover,
    rules.discoverEnabled,
    rules.discoverLimit,
    rules.llm.prompt,
    effectiveLockedIds?.length,
    discoverResult.pending,
    discoverResult.shown,
    discoverStatus.judgeAvailable,
    discoverStatus.judgeError,
    discoverStatus.judging,
    discoverStatus.judgeSettledVersion,
    today,
  ]);

  const shown = useMemo(
    () => blendFeed(followingResult.shown, discoverResult.shown),
    [followingResult.shown, discoverResult.shown],
  );

  const hidden = useMemo(
    () => [...followingResult.hidden, ...discoverResult.hidden],
    [followingResult.hidden, discoverResult.hidden],
  );

  const pending = useMemo(
    () => [...followingResult.pending, ...discoverResult.pending],
    [followingResult.pending, discoverResult.pending],
  );

  const continuing: Progress[] = useMemo(
    () => Object.values(progress).filter((p) => !p.done && p.t > 30).sort((a, b) => b.at - a.at).slice(0, 3),
    [progress],
  );

  const unjudgedFingerprint = useMemo(() => {
    if (!rules.llm.enabled) return "";
    const missing: string[] = [];
    for (const v of all) {
      if (needsLlmJudge(v, rules) && !activeJudgments[v.id]) missing.push(v.id);
    }
    return `${rules.llm.scope}:${rules.llm.prompt}:${missing.length}:${missing.slice(0, 5).join(",")}`;
  }, [all, rules, activeJudgments]);

  useEffect(() => {
    if (rulesOverride || !rules.llm.enabled || !all.length) return;
    if (discoverStatus.judgeAvailable === false) return;
    const timer = setTimeout(() => {
      judgeFeedVideos([...discoverAll, ...followingAll], rules).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [unjudgedFingerprint, rulesOverride, discoverStatus.judgeAvailable]);

  return {
    all,
    followingAll,
    discoverAll,
    rules,
    shown,
    shownFollowing: followingResult.shown,
    shownFollowingAll: followingUncapped,
    channelOverflow: followingResult.channelOverflow,
    shownDiscover: discoverResult.shown,
    hidden,
    pending,
    continuing,
    progress,
    discover,
    judgments: activeJudgments,
    personalScores,
    tasteProfile,
    blockedChannels,
  };
}

export function toVideo(p: Progress): Video {
  return { ...p.video, seconds: p.video.seconds ?? p.d };
}
