import type { ChapterSummary, ParsedBook, ReadingProgress } from "../shared/types.ts";
// Pure and free of the DOM: the library must count progress exactly as the reader's top bar does.
import { bookPercent, readableBlocks, textFraction } from "../src/reader/book.ts";

/**
 * Where a saved reading position is in the book, for the library's "Continue" line.
 * `wordCounts` is each chapter's word count by id; `offset` is where the line the reader was on starts in the block's text.
 * Null when the chapter or block is not in the book.
 */
export function describePosition(
  book: ParsedBook,
  wordCounts: Record<string, number>,
  chapterId: string,
  blockId: string,
  offset = 0,
): Pick<ReadingProgress, "chapterTitle" | "percent"> | null {
  const chapter = book.chapters.find((candidate) => candidate.id === chapterId);
  if (!chapter) return null;
  const blocks = readableBlocks(chapter);
  const at = blocks.findIndex((block) => block.id === blockId);
  if (at === -1) return null;

  const summaries: ChapterSummary[] = book.chapters.map(({ id, title, kind, startPage, endPage }) => ({
    id,
    title,
    kind,
    startPage,
    endPage,
    wordCount: wordCounts[id] ?? 0,
  }));
  return { chapterTitle: chapter.title, percent: bookPercent(summaries, chapterId, textFraction(blocks.map((block) => block.text.length), at, offset)) };
}
