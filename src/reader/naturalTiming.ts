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

// Cutting a voice's audio and text is the same on the device and on the voice box, so it lives with both.
export { chunksOf, trimSilence } from "../../shared/speech-audio.ts";

/** A computer keeps ahead of the voice if making a second of speech takes under 0.7 s (the rest is room for a busy one). */
export const fastEnough = (secondsToMakeASecond: number): boolean => secondsToMakeASecond < 0.7;
