// Where the sentence being read sits in the window, and when the page should follow it.

type Box = { top: number; bottom: number };

/** Window space taken by the top bar and by the player: text there is not really on screen. */
const TOP_EDGE = 52;
const BOTTOM_EDGE = 90;

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
