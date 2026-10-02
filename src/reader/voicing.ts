// How the book is voiced so it sounds read by a person: the pauses a reader makes at punctuation and between sentences.
// Browsers ignore SSML, so the pauses come from the text the voice is given and from silences between utterances.

// A dash joining words ("philosophy\u2014for", "real--or", "matter \u2013 something") is a pause a reader makes, but
// voices often run straight over it. A dash inside a number range ("1685\u20131753") is left alone.
const JOINING_DASH = /\s*(?:\u2014|--)\s*|\s+\u2013\s+/g;

/** `text` as the voice should read it, and a way back from an offset in it to the same place in `text`. */
export function forSpeech(text: string): { text: string; original: (offset: number) => number } {
  // Where each stretch of the spoken text starts, and where the same stretch starts in the book's text.
  const stretches: Array<{ spoken: number; book: number }> = [{ spoken: 0, book: 0 }];
  let spoken = "";
  let from = 0;
  for (const match of text.matchAll(JOINING_DASH)) {
    spoken += `${text.slice(from, match.index)}, `;
    from = match.index + match[0].length;
    stretches.push({ spoken: spoken.length, book: from });
  }
  spoken += text.slice(from);
  return {
    text: spoken,
    original(offset) {
      const stretch = stretches.findLast((candidate) => candidate.spoken <= offset) ?? { spoken: 0, book: 0 };
      return stretch.book + offset - stretch.spoken;
    },
  };
}

/** Silences in milliseconds at the normal speed. Voices add a little of their own at a comma or a full stop. */
const PAUSES = {
  // Audiobook narration pauses about 300 ms inside a sentence and grow with the length of the phrase.
  shortSentence: 300,
  longSentence: 450,
  paragraph: 1000,
  // Audiobook standards leave about 2.5 s after a chapter title.
  heading: 1800,
  title: 2500,
};

/** A sentence this long (about ten syllables) or longer is taken a breath after. */
const LONG_SENTENCE_CHARS = 45;

export type Spoken = { blockId: string; kind: "text" | "heading" | "title"; length: number };

/** How long to stay silent after `ended` before `next` begins, as a reader would; shorter at a faster speed. */
export function pauseBetween(ended: Spoken, next: Spoken, rate: number): number {
  let pause: number;
  if (ended.kind === "title") pause = PAUSES.title;
  else if (ended.kind === "heading" || next.kind !== "text") pause = PAUSES.heading;
  else if (ended.blockId !== next.blockId) pause = PAUSES.paragraph;
  else pause = Math.max(ended.length, next.length) >= LONG_SENTENCE_CHARS ? PAUSES.longSentence : PAUSES.shortSentence;
  return Math.round(pause / rate);
}

export type VoiceInfo = { name: string; lang: string; localService: boolean };

// Voices that ship with macOS for fun or as old robot voices. They are listed first alphabetically, so with no better
// voice to separate them one of them would be read to the reader.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Fred|Good News|Jester|Junior|Kathy|Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/;

/**
 * The most natural-sounding English voice. One that runs on this computer comes first: network voices cut a long
 * sentence off after about fifteen seconds in Chrome and, like every Android voice, may report no word positions,
 * which the highlight needs.
 */
export function pickVoice<T extends VoiceInfo>(voices: T[]): T | null {
  const score = (voice: VoiceInfo) =>
    (voice.localService ? 4 : 0) +
    (/premium|enhanced|natural/i.test(voice.name) ? 3 : 0) +
    (/samantha|ava|allison|daniel/i.test(voice.name) ? 2 : 0) +
    (voice.lang === "en-US" ? 1 : 0) -
    (NOVELTY.test(voice.name) ? 20 : 0);
  return voices.filter((voice) => voice.lang.startsWith("en")).sort((a, b) => score(b) - score(a))[0] ?? null;
}
