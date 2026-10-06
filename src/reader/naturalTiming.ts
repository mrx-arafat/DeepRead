// The parts of the natural voice that are plain arithmetic: where each word falls in a sentence of audio, how to trim the
// silence a voice leaves round it, how to cut a long text for it, and whether a computer is quick enough to use it.

export type WordTime = {
  /** Where the word starts in the text. */
  start: number;
  length: number;
  /** Seconds after the audio begins. */
  at: number;
};

// A word's share of the sentence, in letters: a longer word takes longer to say, and the voice holds a moment after a
// comma and longer after a full stop. The voice reports no word positions, so this is what the highlight follows.
const COMMA_HOLD = 3;
const STOP_HOLD = 5;

/** When each word of `text` starts, spread across `seconds` of audio that holds exactly that text. */
export function wordTimes(text: string, seconds: number): WordTime[] {
  const words = [...text.matchAll(/\S+/g)].map((match) => ({ start: match.index, length: match[0].length, word: match[0] }));
  const weights = words.map(({ word }) => {
    const hold = /[.!?]["')\]]*$/.test(word) ? STOP_HOLD : /[,;:]["')\]]*$/.test(word) ? COMMA_HOLD : 0;
    return Math.max(2, word.replace(/[^\p{L}\p{N}]/gu, "").length) + hold;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let before = 0;
  return words.map(({ start, length }, index) => {
    const at = total === 0 ? 0 : (before / total) * seconds;
    before += weights[index] ?? 0;
    return { start, length, at };
  });
}

/**
 * The audio without the silence a voice leaves before and after a sentence, so the pauses between sentences are the ones
 * DeepRead chooses and not those plus the voice's own. A short margin stays so no word is clipped, and a pause inside
 * the sentence is left as it is.
 */
export function trimSilence(audio: Float32Array, sampleRate: number, marginMs = 50, threshold = 0.01): Float32Array {
  const window = Math.max(1, Math.round(sampleRate * 0.02));
  const loud = (from: number): boolean => {
    let sum = 0;
    const end = Math.min(from + window, audio.length);
    for (let i = from; i < end; i++) sum += (audio[i] ?? 0) ** 2;
    return Math.sqrt(sum / window) >= threshold;
  };
  let first = 0;
  while (first < audio.length && !loud(first)) first += window;
  let last = audio.length;
  while (last > first && !loud(last - window)) last -= window;
  const margin = Math.round((sampleRate * marginMs) / 1000);
  // All silence: keep a moment of it, so what is played is still an utterance.
  if (first >= audio.length) return audio.subarray(0, Math.min(audio.length, margin));
  return audio.subarray(Math.max(0, first - margin), Math.min(audio.length, last + margin));
}

/** Pieces of `text` of at most `max` characters, cut at the last pause or space before the limit. */
export function chunksOf(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    let cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "), head.lastIndexOf("; "), head.lastIndexOf(": "));
    if (cut < max * 0.4) cut = Math.max(cut, head.lastIndexOf(", "));
    if (cut < max * 0.4) cut = Math.max(cut, head.lastIndexOf(" ") - 1);
    // A pause cut keeps its mark; the space after it goes.
    const end = cut < 1 ? max : cut + 1;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** A computer keeps ahead of the voice if making a second of speech takes under 0.7 s (the rest is room for a busy one). */
export const fastEnough = (secondsToMakeASecond: number): boolean => secondsToMakeASecond < 0.7;
