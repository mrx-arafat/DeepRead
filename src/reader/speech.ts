// Read-aloud through the browser's built-in voices (works offline, no keys).

let cachedVoice: SpeechSynthesisVoice | null = null;

/** Prefer a natural-sounding English voice that runs on this machine (those report word positions). */
function englishVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const voices = speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith("en"));
  const score = (voice: SpeechSynthesisVoice) =>
    (voice.localService ? 4 : 0) +
    (/premium|enhanced|natural/i.test(voice.name) ? 3 : 0) +
    (/samantha|ava|allison|daniel/i.test(voice.name) ? 2 : 0) +
    (voice.lang === "en-US" ? 1 : 0);
  cachedVoice = voices.sort((a, b) => score(b) - score(a))[0] ?? null;
  return cachedVoice;
}

export const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

if (canSpeak) {
  // Voices load asynchronously in Chrome; forget the pick when the list changes.
  speechSynthesis.addEventListener("voiceschanged", () => {
    cachedVoice = null;
  });
}

export type SpeakOptions = {
  rate?: number;
  lang?: string;
  /** Called as each word starts, with its position inside `text`. */
  onWord?: (start: number, length: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
};

/** Speak `text`, replacing anything already being spoken. Returns a function that stops it. */
export function speak(text: string, options: SpeakOptions = {}): () => void {
  if (!canSpeak) {
    options.onError?.("This browser cannot read aloud.");
    return () => {};
  }
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
    if (!stopped && event.name === "word") options.onWord?.(event.charIndex, event.charLength ?? 0);
  };
  utterance.onend = () => {
    if (!stopped) options.onEnd?.();
  };
  utterance.onerror = (event) => {
    if (stopped || event.error === "interrupted" || event.error === "canceled") return;
    options.onError?.("Reading aloud stopped unexpectedly. Press play to try again.");
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
  return () => {
    stopped = true;
    speechSynthesis.cancel();
  };
}
