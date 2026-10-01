// The book as one continuous read: what each chapter shows and how far through the whole book the reader is.

import type { Block, Chapter, ChapterSummary, SectionKind } from "../../shared/types.ts";

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Minutes to read `words` at a relaxed pace. */
export const minutes = (words: number): number => Math.max(1, Math.round(words / 180));

/** Books parsed before sections had kinds have none: all of such a book reads as its own text. */
export const kindOf = (section: { kind?: SectionKind }): SectionKind => section.kind ?? "body";

/** Where a book with no saved place opens: its first section of real reading, past the title page and contents. */
export function openingChapter(chapters: ChapterSummary[]): ChapterSummary | undefined {
  return chapters.find((chapter) => kindOf(chapter) === "body") ?? chapters[0];
}

/** The last section of the book's own text: reaching its end is reaching the end of the book. */
export function lastOfText(chapters: ChapterSummary[]): ChapterSummary | undefined {
  return chapters.findLast((chapter) => kindOf(chapter) === "body") ?? chapters.at(-1);
}

/**
 * The section that follows `chapterId` on the page. The book ends with its own text, so back matter (notes, index,
 * licence) is only read when the reader opens it; from there the page carries on through the rest of it.
 */
export function nextInFlow(chapters: ChapterSummary[], chapterId: string): ChapterSummary | undefined {
  const at = chapters.findIndex((chapter) => chapter.id === chapterId);
  const current = chapters[at];
  const next = chapters[at + 1];
  if (!current || !next) return undefined;
  return kindOf(next) === "back" && kindOf(current) !== "back" ? undefined : next;
}

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
 * that chapter's words, over the book's total. Only the book's own text counts: front matter sits at 0 and
 * back matter at 100. Rounded down, so 100 means the very end.
 */
export function bookPercent(chapters: ChapterSummary[], chapterId: string, fraction: number): number {
  const text = chapters.filter((chapter) => kindOf(chapter) === "body");
  const total = text.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  const current = chapters.find((chapter) => chapter.id === chapterId);
  if (!current || total <= 0) return 0;
  if (kindOf(current) !== "body") return kindOf(current) === "back" ? 100 : 0;
  let before = 0;
  for (const chapter of text) {
    if (chapter.id === chapterId) {
      const read = before + chapter.wordCount * Math.min(Math.max(fraction, 0), 1);
      return Math.min(100, Math.floor((read / total) * 100));
    }
    before += chapter.wordCount;
  }
  return 0;
}
