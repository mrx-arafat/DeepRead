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

/** A title short enough to sit inside a sentence. Cuts between words, and never inside a letter the reader sees as one (Bangla). */
export function shortTitle(title: string, max = 60): string {
  const letters = Array.from(new Intl.Segmenter().segment(title.trim()), (part) => part.segment);
  if (letters.length <= max) return letters.join("");
  const kept = letters.slice(0, max);
  // A cut in the middle of a word reads badly; back up to the last space unless that would lose most of the title.
  const space = letters[max]?.trim() === "" ? max : kept.findLastIndex((letter) => letter.trim() === "");
  const end = space > max / 2 ? space : max;
  return `${letters.slice(0, end).join("").trimEnd()}...`;
}
