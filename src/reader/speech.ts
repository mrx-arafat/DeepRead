// Read-aloud through the browser's built-in voices (works offline, no keys).
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

export type SpeakOptions = {
  rate?: number;
  lang?: string;
  /** Called as each word starts, with its position inside `text`. */
  onWord?: (start: number, length: number) => void;
  onEnd?: () => void;
  /** Another utterance (a word pronounced from its card, say) took the voice: wait with `whenVoiceFree`, then speak again. */
  onInterrupted?: () => void;
  onError?: (message: string) => void;
};

/** Speak `text`, replacing anything already being spoken. Returns a function that stops it. */
export function speak(text: string, options: SpeakOptions = {}): () => void {
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
