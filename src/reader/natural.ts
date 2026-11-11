// The natural voice: Kokoro-82M, a small neural voice, run on this device's graphics card in the browser. It is fetched
// once when the reader asks for it (about 326 MB, kept by the browser), then works offline. DeepRead never ships it:
// the code comes from jsDelivr, pinned to one version, and the model from Hugging Face.
//
// The voice lives in a worker of its own (naturalWorker.ts), so loading it and making a sentence never hold up the page.
// This file is the page's side of it: when the worker starts, what it reported, and when it ends. Ending the worker is
// what gives the voice's memory back (over a gigabyte while it loads), so a device that cannot use the voice is never
// left holding it, and what the device turned out to be is remembered, so the next book does not find out again.
import { useSyncExternalStore } from "react";
import { wordTimes } from "./naturalTiming.ts";

export const NATURAL_DOWNLOAD_MB = 326;

/** What the page asks the voice's worker for. */
export type VoiceRequest = { type: "load" } | { type: "clip"; id: number; text: string; speed: number };
/** What the worker answers: how loading went, then a clip (or a failure) for each one asked for. */
export type VoiceReply =
  | { type: "progress"; progress: number }
  | { type: "ready" }
  | { type: "slow" }
  | { type: "unsupported" }
  | { type: "failed"; message: string }
  | { type: "clip"; id: number; audio: Float32Array<ArrayBuffer>; sampleRate: number }
  | { type: "clip-failed"; id: number; message: string };

export type NaturalStatus =
  /** Not asked for, or switched off. */
  | "off"
  | "downloading"
  | "ready"
  /** This browser has no way to use the graphics card for it. */
  | "unsupported"
  /** It runs, but not fast enough to keep ahead of the voice. */
  | "slow"
  /** The page stopped while it was loading: this device has not the memory for it. */
  | "crashed"
  | "failed";

export type NaturalState = { status: NaturalStatus; /** 0 to 1, while downloading. */ progress: number; message: string | null };

const OFF: NaturalState = { status: "off", progress: 0, message: null };
const SLOW: NaturalState = { status: "slow", progress: 0, message: "This device is too slow for the natural voice, so DeepRead keeps the voice built into it." };
const CRASHED: NaturalState = {
  status: "crashed",
  progress: 0,
  message: "The natural voice stopped this page the last time it loaded, so DeepRead keeps the voice built into this device. Choose This device, then Natural, to try again.",
};

// What this device turned out to be, kept per browser like the reading settings: "slow" and "crashed" keep the voice from
// loading again. "loading" is there only while it loads on a page the reader can see, and that page holds a Web Lock of
// the same name for as long: the mark with nobody holding the lock means the last page died with the voice half loaded.
const STORE_KEY = "deepread.naturalVoice";
type Remembered = "loading" | "slow" | "crashed";

function remembered(): Remembered | null {
  try {
    const value = localStorage.getItem(STORE_KEY);
    return value === "loading" || value === "slow" || value === "crashed" ? value : null;
  } catch {
    // Storage blocked: nothing is remembered, and the voice is tried on each visit as before.
    return null;
  }
}

function remember(value: Remembered | null): void {
  try {
    if (value) localStorage.setItem(STORE_KEY, value);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Private mode or full storage: the verdict lasts for this visit only.
  }
}

/** The state a new page starts in: what an earlier page learned about this device, if it learned anything. */
function recalled(): NaturalState {
  const before = remembered();
  return before === "slow" ? SLOW : before === "crashed" ? CRASHED : OFF;
}

/** Whether another page of DeepRead is loading the voice right now: its "loading" mark is not a page that stopped. */
async function loadingElsewhere(): Promise<boolean> {
  const held = await navigator.locks?.query().then(
    (snapshot) => snapshot.held ?? [],
    () => [],
  );
  return held?.some((lock) => lock.name === STORE_KEY) ?? false;
}

let state: NaturalState = recalled();
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let ready = false;
let loading: Promise<void> | null = null;
/** Ends the wait of whoever asked for the load under way. */
let loaded: (() => void) | null = null;
/** Counts the times the voice was let go, so a load begun before that does not carry on after it. */
let letGo = 0;

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
export const naturalReady = (): boolean => ready;

// The "loading" mark stands only while the reader can see the page: a tab the phone closes in the background, or a page
// the reader leaves, is not the voice stopping the page.
const markWhileSeen = () => remember(document.visibilityState === "hidden" ? null : "loading");
const unmark = () => remember(null);

function watchPage(on: boolean) {
  const change = on ? "addEventListener" : "removeEventListener";
  document[change]("visibilitychange", markWhileSeen);
  window[change]("pagehide", unmark);
}

/** Ends the voice's worker, which gives back its memory, and fails whatever it was still making. */
function stop() {
  worker?.terminate();
  worker = null;
  ready = false;
  for (const clip of asked.values()) clip.reject(new Error("The natural voice was stopped."));
  asked.clear();
  clips.clear();
}

/** The load under way is over: `next` is how it went, and `verdict` what to remember of this device. */
function settle(next: NaturalState, verdict: Remembered | null) {
  if (next.status !== "ready") stop();
  watchPage(false);
  remember(verdict);
  set(next);
  loaded?.();
  loaded = null;
}

/**
 * Downloads (the first time), starts and times the voice. Safe to call again: it loads only a voice that has not been
 * tried. One that is ready, that this device cannot run, or that failed to load is left as it is, so reading a sentence
 * aloud never starts the download over; choosing the voice again (disableNatural, then this) is what tries afresh.
 */
export function enableNatural(): Promise<void> {
  if (loading) return loading;
  if (state.status !== "off") return Promise.resolve();
  const attempt = start();
  loading = attempt;
  void attempt.then(() => {
    if (loading === attempt) loading = null;
  });
  return attempt;
}

async function start(): Promise<void> {
  const began = letGo;
  if (remembered() === "loading" && !(await loadingElsewhere())) {
    if (began !== letGo) return;
    remember("crashed");
    set(CRASHED);
    return;
  }
  if (began !== letGo) return;
  const done = load();
  // Held until the load is over, and let go by the browser if this page dies first.
  void navigator.locks?.request(STORE_KEY, { mode: "shared" }, () => done);
  await done;
}

function load(): Promise<void> {
  return new Promise((resolve) => {
    loaded = resolve;
    set({ status: "downloading", progress: 0, message: null });
    remember("loading");
    watchPage(true);
    const voice = new Worker(new URL("./naturalWorker.ts", import.meta.url), { type: "module" });
    worker = voice;
    voice.onmessage = (event: MessageEvent<VoiceReply>) => {
      // A worker that was ended may still have an answer on its way.
      if (voice !== worker) return;
      const reply = event.data;
      if (reply.type === "progress") set({ progress: reply.progress });
      else if (reply.type === "ready") {
        ready = true;
        settle({ status: "ready", progress: 1, message: null }, null);
      } else if (reply.type === "slow") settle(SLOW, "slow");
      else if (reply.type === "unsupported") {
        settle({ status: "unsupported", progress: 0, message: "This browser cannot use the graphics card for it. Try Chrome or Edge on a recent computer." }, null);
      } else if (reply.type === "failed") settle({ status: "failed", progress: 0, message: reply.message }, null);
      else if (reply.type === "clip") {
        asked.get(reply.id)?.resolve({ audio: reply.audio, sampleRate: reply.sampleRate, seconds: reply.audio.length / reply.sampleRate });
        asked.delete(reply.id);
      } else {
        asked.get(reply.id)?.reject(new Error(reply.message));
        asked.delete(reply.id);
      }
    };
    // The worker's own code could not start or stopped: the voice is gone, whether it was loading or reading.
    voice.onerror = () => {
      if (voice === worker) settle({ status: "failed", progress: 0, message: "The natural voice could not be loaded." }, null);
    };
    voice.postMessage({ type: "load" } satisfies VoiceRequest);
  });
}

/** Forgets the voice and frees its memory, as when the reader goes back to the device voice. Choosing it again starts afresh. */
export function disableNatural(): void {
  letGo++;
  stop();
  watchPage(false);
  remember(null);
  loading = null;
  loaded?.();
  loaded = null;
  set(OFF);
}

export type Clip = { audio: Float32Array<ArrayBuffer>; sampleRate: number; seconds: number };

// Voices take about a second to start a sentence, so the sentence after the one being read is made ahead of time, and the
// last few are kept in case the reader goes back or pauses (a sentence is spoken again from the word they stopped at).
const clips = new Map<string, Promise<Clip>>();
const KEPT = 12;
/** The clips the worker is making, by the number each was asked under. */
const asked = new Map<number, { resolve: (clip: Clip) => void; reject: (error: Error) => void }>();
let lastAsked = 0;

/** The audio for `text` at `speed`, made now or already made. */
export function synthesize(text: string, speed: number): Promise<Clip> {
  const key = `${speed}|${text}`;
  const known = clips.get(key);
  if (known) return known;
  const voice = worker;
  const clip = new Promise<Clip>((resolve, reject) => {
    if (!voice || !ready) {
      reject(new Error("The natural voice is not ready."));
      return;
    }
    const id = ++lastAsked;
    asked.set(id, { resolve, reject });
    voice.postMessage({ type: "clip", id, text, speed } satisfies VoiceRequest);
  });
  clips.set(key, clip);
  // A failure is not kept, so the next ask tries again.
  clip.catch(() => {
    if (clips.get(key) === clip) clips.delete(key);
  });
  while (clips.size > KEPT) clips.delete(clips.keys().next().value as string);
  return clip;
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
