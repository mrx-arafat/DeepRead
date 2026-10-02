// Where the sentence being read sits in the window, when the page should follow it, and what a card must not cover.

type Box = { top: number; bottom: number };

/** Window space taken by the top bar and by the player: text there is not really on screen. */
export const TOP_EDGE = 52;
export const BOTTOM_EDGE = 90;

export type Place = "above" | "below" | "in";

/** Whether a box (viewport coordinates) is above the window, below it, or at least partly in view. */
export function placeInView(box: Box, windowHeight: number): Place {
  if (box.bottom <= TOP_EDGE) return "above";
  if (box.top >= windowHeight - BOTTOM_EDGE) return "below";
  return "in";
}

/** The scroll position that puts a sentence a third of the way down the window, or null if it is comfortably placed already. */
export function scrollTopFor(box: Box, windowHeight: number, scrollY: number): number | null {
  if (box.top >= 90 && box.bottom <= windowHeight - 140) return null;
  return scrollY + box.top - windowHeight * 0.3;
}

/**
 * The lines a card about `word` must sit above or below: the word and the sentences the reader needs to see,
 * most important first, for as many of them as still leave the card (`card` tall) room on one side within
 * `view`. A sentence out of view needs no room; with no room at all, the card covers all but the word.
 */
export function clearSpan(word: Box, keep: Box[], card: number, view: Box): Box {
  const seen = keep.filter((box) => box.bottom > view.top && box.top < view.bottom);
  for (let count = seen.length; count > 0; count--) {
    const span = seen.slice(0, count).reduce(
      (all, box) => ({ top: Math.min(all.top, box.top), bottom: Math.max(all.bottom, box.bottom) }),
      word,
    );
    if (span.top - view.top >= card || view.bottom - span.bottom >= card) return span;
  }
  return word;
}
