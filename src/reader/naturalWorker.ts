// The natural voice's own thread. Kokoro-82M is fetched, compiled for the graphics card and run here, so none of that
// work (a third of a gigabyte of model, seconds of compiling, about a second a sentence) holds up the page the reader is
// scrolling. natural.ts starts this worker when the voice is asked for, and ends it to give the memory back.
import type { VoiceReply, VoiceRequest } from "./natural.ts";
import { chunksOf, fastEnough, trimSilence } from "./naturalTiming.ts";

const LIBRARY = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** An American voice, the library's best rated. */
const VOICE = "af_heart";
/** The longest piece the voice is given at once; its limit is about 500 characters. */
const PIECE = 300;
/** Silence between the pieces of a long sentence, as a breath. */
const BREATH_MS = 140;

type Kokoro = {
  generate(text: string, options: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
};
type Progress = { status?: string; file?: string; loaded?: number; total?: number };
type Gpu = { requestAdapter(): Promise<unknown> };
/** What this file uses of the worker's global scope: the DOM types the app is checked with do not describe it. */
type Scope = { postMessage(reply: VoiceReply, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<VoiceRequest>) => void) | null };

const scope = self as unknown as Scope;
let engine: Kokoro | null = null;
// One sentence at a time: the voice cannot make two at once.
let queue: Promise<unknown> = Promise.resolve();

async function hasGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
  return gpu !== undefined && (await gpu.requestAdapter().catch(() => null)) !== null;
}

/** Downloads (the first time), starts and times the voice, and says how that went. */
async function load(): Promise<VoiceReply> {
  if (!(await hasGpu())) return { type: "unsupported" };
  try {
    const { KokoroTTS } = (await import(/* @vite-ignore */ LIBRARY)) as {
      KokoroTTS: { from_pretrained(model: string, options: Record<string, unknown>): Promise<Kokoro> };
    };
    const tts = await KokoroTTS.from_pretrained(MODEL, {
      dtype: "fp32",
      device: "webgpu",
      progress_callback: (event: Progress) => {
        if (event.file?.endsWith(".onnx") && event.total) scope.postMessage({ type: "progress", progress: Math.min(1, (event.loaded ?? 0) / event.total) });
      },
    });
    // The first run compiles the voice for this graphics card and is always slow; the second says how fast it really is.
    const sentence = "Is there any knowledge in the world which is so certain that no reasonable man could doubt it?";
    await tts.generate(sentence, { voice: VOICE, speed: 1 });
    const began = performance.now();
    const probe = await tts.generate(sentence, { voice: VOICE, speed: 1 });
    const spoken = probe.audio.length / probe.sampling_rate;
    if (!fastEnough((performance.now() - began) / 1000 / spoken)) return { type: "slow" };
    engine = tts;
    return { type: "ready" };
  } catch (error) {
    return { type: "failed", message: error instanceof Error ? error.message : "The natural voice could not be loaded." };
  }
}

/** The audio for `text`: its pieces one after another, each without the silence the voice leaves round it. */
async function makeClip(text: string, speed: number): Promise<{ audio: Float32Array<ArrayBuffer>; sampleRate: number }> {
  const tts = engine;
  if (!tts) throw new Error("The natural voice is not ready.");
  const pieces: Float32Array[] = [];
  let sampleRate = 24000;
  for (const piece of chunksOf(text, PIECE)) {
    const made = await tts.generate(piece, { voice: VOICE, speed: Math.min(2, Math.max(0.5, speed)) });
    sampleRate = made.sampling_rate;
    pieces.push(trimSilence(made.audio, sampleRate));
  }
  const breath = Math.round((sampleRate * BREATH_MS) / 1000);
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0) + breath * Math.max(0, pieces.length - 1);
  const audio = new Float32Array(length);
  let at = 0;
  for (const piece of pieces) {
    audio.set(piece, at);
    at += piece.length + breath;
  }
  return { audio, sampleRate };
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "load") {
    void load().then((reply) => scope.postMessage(reply));
    return;
  }
  const { id, text, speed } = request;
  queue = queue
    .then(() => makeClip(text, speed))
    // The audio is handed over, not copied: a sentence is about a megabyte.
    .then(({ audio, sampleRate }) => scope.postMessage({ type: "clip", id, audio, sampleRate }, [audio.buffer]))
    .catch((error: unknown) => scope.postMessage({ type: "clip-failed", id, message: error instanceof Error ? error.message : "The sentence could not be read." }));
};
