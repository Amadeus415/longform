import { refreshFeeds } from "../lib/feed";
import { openExternalUrl } from "../lib/native";
import { play } from "../lib/player";
import { addChannels, blockChannel, getState, removeChannel, saveProgress, setState, unblockChannel } from "../lib/store";
import type { LlmJudgment, Video } from "../lib/types";
import { openRatingSheet } from "./Rating";
import { showActions, span, toast, type Action } from "./ui";

/** The ⋯ menu for a video, shared by the feed, search, and hidden list. */
export function openVideoActions(video: Video, judgment?: LlmJudgment): void {
  const state = getState();
  const progress = state.progress[video.id];
  const rating = state.ratings[video.id];
  const isFollowed = state.channels.some((c) => c.id === video.channelId);
  const length = video.seconds ? span(video.seconds) : undefined;
  const ratingTag = rating ? `You ${rating.score}/10` : undefined;
  const aiTag = judgment ? `AI ${judgment.score}/10${judgment.category ? ` · ${judgment.category}` : ""}` : undefined;

  const actions: Action[] = [
    { icon: "headphones", label: "Listen", run: () => play(video, { mode: "listen" }) },
    { icon: "video", label: "Watch video", run: () => play(video, { mode: "watch" }) },
    {
      icon: rating ? "starFill" : "star",
      label: rating ? `Edit rating (${rating.score}/10)` : "Rate video (1–10)",
      run: () => openRatingSheet(video, judgment),
    },
    progress?.done
      ? { icon: "restore", label: "Mark as unplayed", run: () => forget(video) }
      : { icon: "done", label: "Mark as finished", run: () => finish(video) },
    { icon: "external", label: "Open in YouTube", run: () => openExternalUrl(`https://www.youtube.com/watch?v=${video.id}`) },
  ];

  if (video.channelId) {
    if (isFollowed) {
      actions.push({
        icon: "unfollow",
        label: `Unfollow ${video.channel}`,
        danger: true,
        run: () => unfollow(video.channelId, video.channel),
      });
    } else {
      actions.push({
        icon: "plus",
        label: `Follow ${video.channel}`,
        run: () => follow(video.channelId, video.channel),
      });
      actions.push({
        icon: "eyeOff",
        label: `Hide ${video.channel}`,
        danger: true,
        run: () => hideChannel(video.channelId, video.channel),
      });
    }
  }

  showActions({
    title: video.title,
    subtitle: [video.channel, length, ratingTag, aiTag].filter(Boolean).join(" · "),
    actions,
  });
}

export function finish(video: Video): void {
  const before = getState().progress[video.id];
  const d = video.seconds || before?.d || 0;
  if (!d) return;
  saveProgress(video, d, d);
  toast("Marked as finished", { label: "Undo", run: () => restoreProgress(video.id, before) });
}

function forget(video: Video): void {
  restoreProgress(video.id, undefined);
  toast("Marked as unplayed");
}

function restoreProgress(id: string, before: ReturnType<typeof getState>["progress"][string] | undefined): void {
  setState((s) => {
    const progress = { ...s.progress };
    if (before) progress[id] = before;
    else delete progress[id];
    return { progress };
  });
}

export function follow(id: string, title: string): void {
  addChannels([{ id, title }]);
  refreshFeeds();
  toast(`Following ${title}`);
}

export function hideChannel(id: string, title: string): void {
  blockChannel({ id, title });
  toast(`Hidden ${title}`, {
    label: "Undo",
    run: () => unblockChannel(id),
  });
}

export function unfollow(id: string, title: string): void {
  removeChannel(id);
  toast(`Unfollowed ${title}`, {
    label: "Undo",
    run: () => {
      addChannels([{ id, title }]);
      refreshFeeds();
    },
  });
}
