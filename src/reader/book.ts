// The book as one continuous read: what each chapter shows and how far through the whole book the reader is.

import type { Block, Chapter, ChapterSummary } from "../../shared/types.ts";

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Minutes to read `words` at a relaxed pace. */
export const minutes = (words: number): number => Math.max(1, Math.round(words / 180));

/** The blocks a chapter shows. Its title is already the section heading, so a first block repeating it is dropped. */
export function readableBlocks(chapter: Chapter): Block[] {
  const [first, ...rest] = chapter.blocks;
  return first?.type === "heading" && normalize(first.text) === normalize(chapter.title) ? rest : chapter.blocks;
}

/**
 * Of items stacked top to bottom, the one at `line`: the first whose bottom edge is below it. A line above them all
 * gives the first, a line in the gap between two gives the next; `count` when every item ends above the line.
 */
export function indexAtLine(count: number, bottomOf: (index: number) => number, line: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (bottomOf(mid) > line) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Whole-book progress in percent: the words of every chapter before `chapterId`, plus `fraction` (0 to 1) of
 * that chapter's words, over the book's total. Rounded down, so 100 means the very end.
 */
export function bookPercent(chapters: ChapterSummary[], totalWords: number, chapterId: string, fraction: number): number {
  if (totalWords <= 0) return 0;
  let before = 0;
  for (const chapter of chapters) {
    if (chapter.id === chapterId) {
      const read = before + chapter.wordCount * Math.min(Math.max(fraction, 0), 1);
      return Math.min(100, Math.floor((read / totalWords) * 100));
    }
    before += chapter.wordCount;
  }
  return 0;
}
