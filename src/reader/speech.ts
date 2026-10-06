// Read-aloud through the browser's built-in voices (works offline, no keys), or through the natural voice (natural.ts)
// when the reader chose it and it is ready.
import { naturalReady, play, synthesize } from "./natural.ts";
import type { Playing } from "./natural.ts";
import { pickVoice } from "./voicing.ts";

let cachedVoice: SpeechSynthesisVoice | null = null;

/** The best English voice on this computer (see pickVoice), looked up once. */
function englishVoice(): SpeechSynthesisVoice | null {
  cachedVoice ??= pickVoice(speechSynthesis.getVoices());
  return cachedVoice;
}

export const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

if (canSpeak) {
  // Voices load asynchronously in Chrome; forget the pick when the list changes.
  speechSynthesis.addEventListener("voiceschanged", () => {
    cachedVoice = null;
  });
}

// The voice belongs to the newest utterance: speaking again takes it over from whatever was being said.
let owner: object | null = null;
const freeWaiters = new Set<() => void>();

function release(token: object) {
  if (owner !== token) return;
  owner = null;
  const waiting = [...freeWaiters];
  freeWaiters.clear();
  for (const callback of waiting) callback();
}

/** Calls `callback` once nothing is being spoken (at once if nothing is). Returns a function that withdraws the request. */
export function whenVoiceFree(callback: () => void): () => void {
  if (!owner) {
    callback();
    return () => {};
  }
  freeWaiters.add(callback);
  return () => void freeWaiters.delete(callback);
}

// Whether the reader chose the natural voice. It is used only while it is also ready: until then the device voice reads.
let wantNatural = false;

export function setNaturalVoiceWanted(wanted: boolean): void {
  wantNatural = wanted;
}

// The natural voice's audio is not the speech engine's, so it has to be stopped by hand when something else takes the voice.
let naturalCurrent: { token: object; stop: () => void; interrupted: () => void } | null = null;

function interruptNatural() {
  const current = naturalCurrent;
  naturalCurrent = null;
  current?.stop();
  current?.interrupted();
}

export type SpeakOptions = {
  rate?: number;
  /** `device` speaks with the built-in voice even when the natural one is chosen: a single word should not wait for it. */
  engine?: "device";
  lang?: string;
  /** Called as each word starts, with its position inside `text`. */
  onWord?: (start: number, length: number) => void;
  onEnd?: () => void;
  /** Another utterance (a word pronounced from its card, say) took the voice: wait with `whenVoiceFree`, then speak again. */
  onInterrupted?: () => void;
  onError?: (message: string) => void;
};

/** Gets the voice ready for the sentence about to be read, so it starts without a wait. */
export function prepareSpeech(text: string, rate: number): void {
  if (wantNatural && naturalReady()) void synthesize(text, rate).catch(() => {});
}

function speakNatural(text: string, options: SpeakOptions): () => void {
  const token = {};
  let stopped = false;
  let playing: Playing | null = null;
  const holds = () => !stopped && owner === token;
  owner = token;
  // Whatever the device voice was saying is replaced, and its reader told so by its own events.
  if (canSpeak) speechSynthesis.cancel();
  naturalCurrent = {
    token,
    stop: () => playing?.stop(),
    interrupted: () => {
      if (!stopped) options.onInterrupted?.();
    },
  };
  synthesize(text, options.rate ?? 1)
    .then((clip) => {
      if (!holds()) return;
      playing = play(clip, text, {
        onWord: (start, length) => {
          if (holds()) options.onWord?.(start, length);
        },
        onEnd: () => {
          if (!holds()) return;
          naturalCurrent = null;
          release(token);
          options.onEnd?.();
        },
      });
    })
    .catch(() => {
      if (!holds()) return;
      naturalCurrent = null;
      release(token);
      options.onError?.("Reading aloud stopped unexpectedly. Press play to try again.");
    });
  return () => {
    if (stopped) return;
    stopped = true;
    playing?.stop();
    if (naturalCurrent?.token === token) naturalCurrent = null;
    if (owner === token) release(token);
  };
}

/** Speak `text`, replacing anything already being spoken. Returns a function that stops it. */
export function speak(text: string, options: SpeakOptions = {}): () => void {
  interruptNatural();
  if (wantNatural && naturalReady() && options.engine !== "device") return speakNatural(text, options);
  if (!canSpeak) {
    options.onError?.("This browser cannot read aloud.");
    return () => {};
  }
  const token = {};
  let stopped = false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = options.rate ?? 1;
  if (options.lang) {
    utterance.lang = options.lang;
  } else {
    const voice = englishVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? "en-US";
  }
  utterance.onboundary = (event) => {
    if (!stopped && owner === token && event.name === "word") options.onWord?.(event.charIndex, event.charLength ?? 0);
  };
  utterance.onend = () => {
    if (stopped) return;
    // Some engines report a cancelled utterance as ended: only the one holding the voice finished on its own.
    if (owner === token) {
      release(token);
      options.onEnd?.();
    } else {
      options.onInterrupted?.();
    }
  };
  utterance.onerror = () => {
    if (stopped) return;
    if (owner !== token) {
      options.onInterrupted?.();
      return;
    }
    release(token);
    options.onError?.("Reading aloud stopped unexpectedly. Press play to try again.");
  };
  owner = token;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
  return () => {
    if (stopped) return;
    stopped = true;
    if (owner !== token) return;
    // Cancelling empties the engine's queue, so only do it while this utterance still holds the voice.
    speechSynthesis.cancel();
    release(token);
  };
}
