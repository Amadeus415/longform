import { refreshFeeds } from "../lib/feed";
import { play } from "../lib/player";
import { addChannels, getState, removeChannel, saveProgress, setState } from "../lib/store";
import type { Video } from "../lib/types";
import { showActions, span, toast } from "./ui";

/** The ⋯ menu for a video, shared by the feed, search, and hidden list. */
export function openVideoActions(video: Video): void {
  const progress = getState().progress[video.id];
  const length = video.seconds ? span(video.seconds) : undefined;
  showActions({
    title: video.title,
    subtitle: [video.channel, length].filter(Boolean).join(" · "),
    actions: [
      { icon: "headphones", label: "Listen", run: () => play(video, { mode: "listen" }) },
      { icon: "video", label: "Watch video", run: () => play(video, { mode: "watch" }) },
      progress?.done
        ? { icon: "restore", label: "Mark as unplayed", run: () => forget(video) }
        : { icon: "done", label: "Mark as finished", run: () => finish(video) },
      { icon: "external", label: "Open in YouTube", run: () => window.open(`https://www.youtube.com/watch?v=${video.id}`, "_blank") },
      { icon: "unfollow", label: `Unfollow ${video.channel}`, danger: true, run: () => unfollow(video.channelId, video.channel) },
    ],
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
