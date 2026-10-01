import type { BookSummary } from "../../shared/types.ts";

/** "19 chapters · about 4 h of reading", at the pace the reader's own estimates use. */
export function lengthLabel(book: BookSummary): string {
  const hours = book.wordCount / 180 / 60;
  const length = hours >= 1 ? `about ${Math.round(hours)} h of reading` : `about ${Math.max(1, Math.round(hours * 60))} min of reading`;
  return `${book.chapterCount} chapters · ${length}`;
}

/** Names the file that failed, so the reader knows which one the reason is about. */
export function addFailure(fileName: string, reason: unknown): string {
  const why = reason instanceof Error ? reason.message : "Please try again.";
  return `${fileName} could not be added. ${why}`;
}
