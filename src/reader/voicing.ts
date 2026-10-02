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

/** Silences in milliseconds at the normal speed: after a sentence, after a paragraph, after a title or heading. */
const PAUSES = { sentence: 350, paragraph: 750, title: 1000 };

/** How long to stay silent after `ended` before `next` begins, as a reader would, shorter at a faster speed. */
export function pauseBetween(ended: { blockId: string; title: boolean }, next: { blockId: string }, rate: number): number {
  const kind = ended.title ? "title" : ended.blockId === next.blockId ? "sentence" : "paragraph";
  return Math.round(PAUSES[kind] / rate);
}
