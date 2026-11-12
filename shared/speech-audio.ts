// The parts of read-aloud audio that are plain arithmetic, the same wherever the voice runs: on the reader's device
// (src/reader/naturalWorker.ts) or on the voice box (server/voice-box.ts).

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

/** `pieces` of one sentence played one after another, with `breathMs` of silence between them. */
export function joinPieces(pieces: readonly Float32Array[], sampleRate: number, breathMs: number): Float32Array<ArrayBuffer> {
  const breath = Math.round((sampleRate * breathMs) / 1000);
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0) + breath * Math.max(0, pieces.length - 1);
  const audio = new Float32Array(length);
  let at = 0;
  for (const piece of pieces) {
    audio.set(piece, at);
    at += piece.length + breath;
  }
  return audio;
}
