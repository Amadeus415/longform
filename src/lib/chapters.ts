import type { Chapter } from "./types";

const STAMP = String.raw`[(\[]?((?:\d{1,2}:)?\d{1,2}:\d{2})[)\]]?`;
const SEPARATOR = String.raw`\s*[-–—:|•·]?\s*`;
const STAMP_FIRST = new RegExp(`^${STAMP}${SEPARATOR}(.+)$`); // "0:00 Intro"
const STAMP_LAST = new RegExp(`^(.+?)${SEPARATOR}${STAMP}$`); // "Intro - 0:00"

export function toSeconds(stamp: string): number {
  return stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * Parse YouTube-style chapters ("00:00 Intro", "Intro - 1:02:03") out of a video description.
 * Same idea as YouTube's own rule: at least three timestamps, in ascending order.
 */
export function parseChapters(description: string): Chapter[] {
  const chapters: Chapter[] = [];
  for (const raw of description.split("\n")) {
    const line = raw.trim();
    let stamp: string | undefined;
    let title: string | undefined;
    const first = line.match(STAMP_FIRST);
    const last = first ? null : line.match(STAMP_LAST);
    if (first) [, stamp, title] = first;
    else if (last) [, title, stamp] = last;
    if (!stamp || !title) continue;
    const seconds = toSeconds(stamp);
    title = title.replace(/^[\s\-–—:|•·]+|[\s\-–—:|•·]+$/g, "").trim();
    if (!title || (chapters.length && seconds <= chapters[chapters.length - 1][0])) continue;
    chapters.push([seconds, title.slice(0, 120)]);
  }
  return chapters.length >= 3 ? chapters : [];
}
