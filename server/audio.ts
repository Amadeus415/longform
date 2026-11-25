import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { cached, forget } from "./cache.ts";

// Listen mode streams a video's audio track through this server so the phone can play it in a plain
// <audio> element. Unlike a YouTube embed, an <audio> element keeps playing when the screen locks.
//
// yt-dlp finds the audio stream (format 140: AAC in MP4, which every browser including iOS Safari plays).
// The stream URL only works from the server's own IP, so we relay the bytes and support HTTP Range
// requests, which Safari and iOS AVPlayer need to seek and to start playing at all.
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
const COOKIES_TMP = "/tmp/longform-yt-cookies.txt";

type Stream = { url: string; size: number; type: string };

let cookiesPathMemo: string | null | undefined;
function cookiesPath(): string | null {
  if (cookiesPathMemo !== undefined) return cookiesPathMemo;
  const direct = process.env.YTDLP_COOKIES_PATH?.trim();
  if (direct) return (cookiesPathMemo = direct);
  const b64 = process.env.YTDLP_COOKIES_B64?.trim();
  if (b64) {
    try {
      const content = Buffer.from(b64, "base64");
      writeFileSync(COOKIES_TMP, content, { mode: 0o600 });
      return (cookiesPathMemo = COOKIES_TMP);
    } catch (error) {
      console.error(`[audio] Failed to decode YTDLP_COOKIES_B64: ${(error as Error).message}`);
    }
  }
  return (cookiesPathMemo = null);
}

function ytdlpArgs(id: string): string[] {
  const args = [
    "-f", "140/bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio",
    "--dump-json", "--skip-download", "--no-playlist", "--no-warnings",
    "--js-runtimes", "node",
  ];
  const cookies = cookiesPath();
  if (cookies) args.push("--cookies", cookies);
  const proxy = process.env.YTDLP_PROXY?.trim();
  if (proxy) args.push("--proxy", proxy);
  const extractor = process.env.YTDLP_EXTRACTOR_ARGS?.trim();
  if (extractor) args.push("--extractor-args", extractor);
  args.push(`https://www.youtube.com/watch?v=${id}`);
  return args;
}

function resolve(id: string): Promise<Stream> {
  return cached(`audio:${id}`, 4 * 60 * 60_000, async () => {
    const { stdout } = await run(YTDLP, ytdlpArgs(id), { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    const info = JSON.parse(stdout);
    const url: string = info.url;
    const size = Number(info.filesize ?? new URL(url).searchParams.get("clen"));
    if (!url || !size) throw new Error("No audio stream found");
    const wait = Number(info.available_at ?? 0) * 1000 - Date.now();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait + 300));
    const types: Record<string, string> = { m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", mp3: "audio/mpeg", ogg: "audio/ogg" };
    return { url, size, type: types[info.ext] ?? "application/octet-stream" };
  });
}

/** Start resolving a stream ahead of time, so pressing play is instant. */
export function warmAudio(id: string): void {
  if (VIDEO_ID.test(id)) resolve(id).catch(() => {});
}

export async function audioResponse(request: Request, id: string): Promise<Response> {
  if (!VIDEO_ID.test(id)) return new Response("Bad video id", { status: 400 });
  try {
    return await respond(request, id);
  } catch (error) {
    if (!request.signal.aborted) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      console.error(`[audio] ${id}: ${missing ? "yt-dlp is not installed (brew install yt-dlp)" : (error as Error).message.split("\n")[0]}`);
    }
    return new Response("Audio unavailable for this video", { status: 502 });
  }
}

async function respond(request: Request, id: string): Promise<Response> {
  let stream = await resolve(id);
  // A cached stream URL can expire. When YouTube says so, look it up again (once) and carry on.
  const refresh = async () => {
    forget(`audio:${id}`);
    stream = await resolve(id);
    return stream.url;
  };

  const range = parseRange(request.headers.get("range"), stream.size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stream.size}` } });
  }
  const [start, end] = range ?? [0, stream.size - 1];

  const headers = new Headers({
    "Content-Type": stream.type,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  });
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stream.size}`);
  if (request.method === "HEAD") {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  // Fetch the first chunk before answering, so an expired URL never reaches the client as an error.
  let first = await fetchChunk(stream.url, start, Math.min(end, start + CHUNK - 1), request.signal);
  if (expired(first)) {
    await first.body?.cancel();
    first = await fetchChunk(await refresh(), start, Math.min(end, start + CHUNK - 1), request.signal);
  }
  if (!first.ok || !first.body) throw new Error(`Upstream returned ${first.status}`);

  return new Response(relay(first, stream.url, refresh, start, end, request.signal), { status: range ? 206 : 200, headers });
}

function expired(response: Response): boolean {
  return response.status === 403 || response.status === 410;
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
function relay(
  first: Response,
  url: string,
  refresh: () => Promise<string>,
  start: number,
  end: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
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
          const chunkEnd = Math.min(end, next + CHUNK - 1);
          let response = await fetchChunk(url, next, chunkEnd, signal);
          if (expired(response)) {
            await response.body?.cancel();
            url = await refresh(); // a long episode can outlive its stream URL
            response = await fetchChunk(url, next, chunkEnd, signal);
          }
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
