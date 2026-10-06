// The natural voice: Kokoro-82M, a small neural voice, run on this computer's graphics card in the browser. It is fetched
// once when the reader asks for it (about 326 MB, kept by the browser), then works offline. DeepRead never ships it:
// the code comes from jsDelivr, pinned to one version, and the model from Hugging Face.
import { useSyncExternalStore } from "react";
import { chunksOf, fastEnough, trimSilence, wordTimes } from "./naturalTiming.ts";

const LIBRARY = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** An American voice, the library's best rated. */
const VOICE = "af_heart";
export const NATURAL_DOWNLOAD_MB = 326;

type Kokoro = {
  generate(text: string, options: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
};
type Progress = { status?: string; file?: string; loaded?: number; total?: number };
type Gpu = { requestAdapter(): Promise<unknown> };

export type NaturalStatus =
  /** Not asked for, or switched off. */
  | "off"
  | "downloading"
  | "ready"
  /** This browser has no way to use the graphics card for it. */
  | "unsupported"
  /** It runs, but not fast enough to keep ahead of the voice. */
  | "slow"
  | "failed";

export type NaturalState = { status: NaturalStatus; /** 0 to 1, while downloading. */ progress: number; message: string | null };

let state: NaturalState = { status: "off", progress: 0, message: null };
const listeners = new Set<() => void>();
let engine: Kokoro | null = null;
let loading: Promise<void> | null = null;

function set(next: Partial<NaturalState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** The voice's state, and re-render when it changes. */
export function useNaturalState(): NaturalState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => state,
  );
}

/** Whether the natural voice can read the next sentence now. */
export const naturalReady = (): boolean => engine !== null;

async function hasGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
  return gpu !== undefined && (await gpu.requestAdapter().catch(() => null)) !== null;
}

/** Downloads (the first time), starts and times the voice. Safe to call again: it does nothing once it is ready. */
export function enableNatural(): Promise<void> {
  if (engine) return Promise.resolve();
  loading ??= load().finally(() => {
    loading = null;
  });
  return loading;
}

async function load(): Promise<void> {
  if (!(await hasGpu())) {
    set({ status: "unsupported", progress: 0, message: "This browser cannot use the graphics card for it. Try Chrome or Edge on a recent computer." });
    return;
  }
  set({ status: "downloading", progress: 0, message: null });
  try {
    const { KokoroTTS } = (await import(/* @vite-ignore */ LIBRARY)) as {
      KokoroTTS: { from_pretrained(model: string, options: Record<string, unknown>): Promise<Kokoro> };
    };
    const tts = await KokoroTTS.from_pretrained(MODEL, {
      dtype: "fp32",
      device: "webgpu",
      progress_callback: (event: Progress) => {
        if (event.file?.endsWith(".onnx") && event.total) set({ progress: Math.min(1, (event.loaded ?? 0) / event.total) });
      },
    });
    // The first run compiles the voice for this graphics card and is always slow; the second says how fast it really is.
    const sentence = "Is there any knowledge in the world which is so certain that no reasonable man could doubt it?";
    await tts.generate(sentence, { voice: VOICE, speed: 1 });
    const began = performance.now();
    const probe = await tts.generate(sentence, { voice: VOICE, speed: 1 });
    const spoken = probe.audio.length / probe.sampling_rate;
    if (!fastEnough((performance.now() - began) / 1000 / spoken)) {
      set({ status: "slow", progress: 0, message: "This computer is too slow for the natural voice, so DeepRead keeps the voice built into it." });
      return;
    }
    engine = tts;
    set({ status: "ready", progress: 1, message: null });
  } catch (error) {
    set({ status: "failed", progress: 0, message: error instanceof Error ? error.message : "The natural voice could not be loaded." });
  }
}

/** Forgets the voice and frees its memory, as when the reader goes back to the device voice. */
export function disableNatural(): void {
  engine = null;
  clips.clear();
  set({ status: "off", progress: 0, message: null });
}

export type Clip = { audio: Float32Array<ArrayBuffer>; sampleRate: number; seconds: number };

// Voices take about a second to start a sentence, so the sentence after the one being read is made ahead of time, and the
// last few are kept in case the reader goes back or pauses (a sentence is spoken again from the word they stopped at).
const clips = new Map<string, Promise<Clip>>();
const KEPT = 12;
let queue: Promise<unknown> = Promise.resolve();
/** The longest piece the voice is given at once; its limit is about 500 characters. */
const PIECE = 300;
/** Silence between the pieces of a long sentence, as a breath. */
const BREATH_MS = 140;

/** The audio for `text` at `speed`, made now or already made. */
export function synthesize(text: string, speed: number): Promise<Clip> {
  const key = `${speed}|${text}`;
  const known = clips.get(key);
  if (known) return known;
  const made = (queue = queue.then(() => makeClip(text, speed)));
  const clip = made as Promise<Clip>;
  clips.set(key, clip);
  // A failure is not kept, so the next ask tries again.
  clip.catch(() => clips.delete(key));
  while (clips.size > KEPT) clips.delete(clips.keys().next().value as string);
  return clip;
}

async function makeClip(text: string, speed: number): Promise<Clip> {
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
  return { audio, sampleRate, seconds: length / sampleRate };
}

let context: AudioContext | null = null;

export type Playing = { stop(): void };

/** Plays a clip, telling `onWord` where in `text` the voice is as it goes, and `onEnd` when it has finished. */
export function play(clip: Clip, text: string, handlers: { onWord?: (start: number, length: number) => void; onEnd: () => void }): Playing {
  context ??= new AudioContext();
  void context.resume();
  const buffer = context.createBuffer(1, clip.audio.length, clip.sampleRate);
  buffer.copyToChannel(clip.audio, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);

  const times = wordTimes(text, clip.seconds);
  const startsAt = context.currentTime + 0.02;
  let next = 0;
  let stopped = false;
  const follow = () => {
    const elapsed = (context?.currentTime ?? 0) - startsAt;
    while (next < times.length && (times[next]?.at ?? Infinity) <= elapsed) {
      const word = times[next++];
      if (word) handlers.onWord?.(word.start, word.length);
    }
  };
  // An interval, not animation frames: a page in the background still reads aloud.
  const timer = setInterval(follow, 40);
  source.onended = () => {
    clearInterval(timer);
    if (!stopped) handlers.onEnd();
  };
  source.start(startsAt);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        source.stop();
      } catch {
        // Already finished.
      }
      source.disconnect();
    },
  };
}
