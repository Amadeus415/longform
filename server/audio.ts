import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cached, forget } from "./cache.ts";

// Listen mode streams a video's audio track through this server so the phone can play it in a plain
// <audio> element. Unlike a YouTube embed, an <audio> element keeps playing when the screen locks.
//
// yt-dlp finds the audio stream (format 140: AAC in MP4, which every browser including iOS Safari plays).
// The stream URL only works from the server's own IP, so we relay the bytes and support HTTP Range
// requests, which Safari needs to seek and to start playing at all.
//
// Two YouTube quirks this handles:
// - A fresh stream URL is not valid until a few seconds after it is issued ("available_at"), and
//   requesting it too early invalidates it for good. So we wait, exactly like yt-dlp does.
// - The URL rejects the HTTP Range header; the byte range has to go in a "range" query parameter.

const run = promisify(execFile);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const VIDEO_ID = /^[\w-]{11}$/;
// googlevideo throttles large range requests, so fetch upstream in chunks no bigger than this.
const CHUNK = 8 * 1024 * 1024;

type Stream = { url: string; size: number; type: string };

function resolve(id: string): Promise<Stream> {
  return cached(`audio:${id}`, 4 * 60 * 60_000, async () => {
    const { stdout } = await run(
      YTDLP,
      [
        "-f", "140/bestaudio[ext=m4a]/bestaudio",
        "--dump-json", "--skip-download", "--no-playlist", "--no-warnings",
        "--js-runtimes", "node",
        `https://www.youtube.com/watch?v=${id}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
    );
    const info = JSON.parse(stdout);
    const url: string = info.url;
    const size = Number(info.filesize ?? new URL(url).searchParams.get("clen"));
    if (!url || !size) throw new Error("No audio stream found");
    const wait = Number(info.available_at ?? 0) * 1000 - Date.now();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait + 300));
    return { url, size, type: info.ext === "webm" ? "audio/webm" : "audio/mp4" };
  });
}

/** Start resolving a stream ahead of time, so pressing play is instant. */
export function warmAudio(id: string): void {
  if (VIDEO_ID.test(id)) resolve(id).catch(() => {});
}

export async function audioResponse(request: Request, id: string): Promise<Response> {
  if (!VIDEO_ID.test(id)) return new Response("Bad video id", { status: 400 });

  let stream: Stream;
  try {
    stream = await resolve(id);
  } catch (error) {
    console.error(`[audio] ${id}: ${(error as Error).message.split("\n")[0]}`);
    return new Response("Audio unavailable for this video", { status: 502 });
  }

  const range = parseRange(request.headers.get("range"), stream.size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stream.size}` } });
  }
  const [start, end] = range ?? [0, stream.size - 1];

  // Fetch the first chunk before answering, so an expired stream URL can be retried transparently.
  let first = await fetchChunk(stream.url, start, Math.min(end, start + CHUNK - 1), request.signal);
  if (first.status === 403 || first.status === 410) {
    forget(`audio:${id}`);
    stream = await resolve(id);
    first = await fetchChunk(stream.url, start, Math.min(end, start + CHUNK - 1), request.signal);
  }
  if (!first.ok || !first.body) return new Response("Upstream error", { status: 502 });

  const body = relay(first, stream.url, start, end, request.signal);
  const headers = new Headers({
    "Content-Type": stream.type,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  });
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stream.size}`);
  return new Response(body, { status: range ? 206 : 200, headers });
}

function parseRange(header: string | null, size: number): [number, number] | null | "invalid" {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2])); // "bytes=-500" means the last 500 bytes
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? "invalid" : [start, end];
}

function fetchChunk(url: string, start: number, end: number, signal: AbortSignal): Promise<Response> {
  return fetch(`${url}&range=${start}-${end}`, { signal });
}

/** Stream bytes start..end to the client, fetching one upstream chunk at a time. */
function relay(first: Response, url: string, start: number, end: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  let reader = first.body!.getReader();
  let next = Math.min(end, start + CHUNK - 1) + 1;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (value) return controller.enqueue(value);
          if (!done) continue;
          if (next > end) return controller.close();
          const response = await fetchChunk(url, next, Math.min(end, next + CHUNK - 1), signal);
          if (!response.ok || !response.body) throw new Error(`Upstream returned ${response.status}`);
          reader = response.body.getReader();
          next = Math.min(end, next + CHUNK - 1) + 1;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}
