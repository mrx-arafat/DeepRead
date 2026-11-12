// The voice box: a small service on a machine of its own that reads the natural voice for DeepRead, so that readers'
// devices and the DeepRead server never run the voice model. DeepRead sends it one sentence at a time (server/voice.ts)
// and keeps each clip with the book, so the box makes a sentence only once. Run it with voice-box/Dockerfile; started
// as `node server/voice-box.ts`, it reads its settings from the environment (see main below).
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";
import { chunksOf, joinPieces, trimSilence } from "../shared/speech-audio.ts";

/** Speech for `text` at `speed`: the voice model, or a stand-in in tests. */
export type Speak = (text: string, speed: number) => Promise<{ audio: Float32Array; sampleRate: number }>;
/** An MP3 of mono `audio`. */
export type Encode = (audio: Float32Array, sampleRate: number) => Promise<Buffer>;

/** A sentence, with room for a long one; the same limit as DeepRead's own route. */
const MAX_TEXT = 1200;
/** The longest piece the voice is given at once; its limit is about 500 characters. */
const PIECE = 300;
/** Silence between the pieces of a long sentence, as a breath. */
const BREATH_MS = 140;
const MAX_BODY = 8 * 1024;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

function reply(response: ServerResponse, status: number, body: string | Buffer, type = "application/json"): void {
  response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(null);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

/**
 * The box's HTTP side: `POST /clip` with `{"text", "speed"}` and the token answers an MP3 of the sentence; `GET /health`
 * answers when the box is up. One sentence is read at a time, since each already uses every core the box may have,
 * and at most `maxQueue` wait: past that the box says it is busy and the reader's own device voice reads instead.
 */
export function voiceBoxHandler(options: { token: string; speak: Speak; encode: Encode; maxQueue: number }): RequestListener {
  const expected = digest(`Bearer ${options.token}`);
  // SHORTCUT: one sentence at a time on one model. Run a second model in its own process if readers wait on a busy box.
  let line: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  async function clip(text: string, speed: number): Promise<Buffer> {
    const pieces: Float32Array[] = [];
    let sampleRate = 24000;
    for (const piece of chunksOf(text, PIECE)) {
      const made = await options.speak(piece, speed);
      sampleRate = made.sampleRate;
      pieces.push(trimSilence(made.audio, sampleRate));
    }
    return options.encode(joinPieces(pieces, sampleRate, BREATH_MS), sampleRate);
  }

  return async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return reply(response, 200, '{"ok":true}');
    if (request.method !== "POST" || request.url !== "/clip") return reply(response, 404, '{"error":"not_found"}');
    if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expected)) return reply(response, 401, '{"error":"unauthorized"}');

    const raw = await readBody(request);
    let body: unknown = null;
    try {
      body = raw === null ? null : JSON.parse(raw);
    } catch {
      body = null;
    }
    const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const text = typeof fields.text === "string" ? fields.text.trim() : "";
    const speed = typeof fields.speed === "number" ? fields.speed : Number.NaN;
    if (!text || text.length > MAX_TEXT || !(speed >= 0.5 && speed <= 2)) return reply(response, 400, '{"error":"invalid_body"}');

    if (waiting >= options.maxQueue) return reply(response, 503, '{"error":"busy"}');
    waiting++;
    const made = line.then(() => clip(text, speed));
    line = made.catch(() => {});
    try {
      reply(response, 200, await made, "audio/mpeg");
    } catch (error) {
      console.error("could not read a sentence:", error);
      reply(response, 500, '{"error":"voice_failed"}');
    } finally {
      waiting--;
    }
  };
}

/** Kokoro-82M on this machine's CPU, loaded once and warmed up so the first reader does not pay for it. */
async function loadVoice(): Promise<Speak> {
  // Named in a variable: the package is installed only in the voice box's image, not with DeepRead.
  const library = "kokoro-js";
  const { KokoroTTS } = (await import(library)) as {
    KokoroTTS: {
      from_pretrained(model: string, options: Record<string, unknown>): Promise<{
        generate(text: string, options: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
      }>;
    };
  };
  const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" });
  const speak: Speak = async (text, speed) => {
    const made = await tts.generate(text, { voice: "af_heart", speed });
    return { audio: made.audio, sampleRate: made.sampling_rate };
  };
  await speak("The voice box is ready.", 1);
  return speak;
}

/** ffmpeg turns the samples into a small MP3: mono, 32 kbps, plenty for one voice. */
const encodeMp3: Encode = (audio, sampleRate) =>
  new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-v", "error", "-f", "f32le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0", "-codec:a", "libmp3lame", "-b:a", "32k", "-f", "mp3", "pipe:1"]);
    const out: Buffer[] = [];
    let errors = "";
    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${errors.slice(0, 300)}`))));
    ffmpeg.stdin.end(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
  });

/**
 * VOICE_TOKEN (32 characters or more, the same as DeepRead's DEEPREAD_VOICE_TOKEN), VOICE_TLS_KEY and VOICE_TLS_CERT
 * (files: the sentence is the book's text, so it only travels encrypted), VOICE_PORT (8443) and VOICE_QUEUE (16).
 */
async function main(): Promise<void> {
  const token = process.env.VOICE_TOKEN ?? "";
  if (token.length < 32) throw new Error("VOICE_TOKEN must be 32 characters or more.");
  const key = readFileSync(process.env.VOICE_TLS_KEY ?? "", "utf8");
  const cert = readFileSync(process.env.VOICE_TLS_CERT ?? "", "utf8");
  const port = Number(process.env.VOICE_PORT ?? 8443);
  const maxQueue = Number(process.env.VOICE_QUEUE ?? 16);
  const speak = await loadVoice();
  createServer({ key, cert }, voiceBoxHandler({ token, speak, encode: encodeMp3, maxQueue })).listen(port, () => {
    console.log(`The voice box reads on port ${port}.`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`The voice box could not start. ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
