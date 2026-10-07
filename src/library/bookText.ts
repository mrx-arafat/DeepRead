import type { BookSummary, ReadingProgress, ReadingStatus } from "../../shared/types.ts";
import { minutes } from "../reader/book.ts";

/** A book the reader has opened: the library can say where they stopped. */
export type StartedBook = BookSummary & { progress: ReadingProgress };

/** How many cloths a cover can be bound in: --cloth-1 to --cloth-10 in the stylesheet. */
export const CLOTH_COUNT = 10;

/** The cloth (1 to CLOTH_COUNT) a title is bound in: the same one every time, whatever the title's case or spacing. */
export function clothFor(title: string): number {
  // FNV-1a over the letters: a few lines, and it spreads similar titles across the cloths. Its high bits are the
  // well mixed ones, so the cloth is read from those and not from the remainder of a division.
  let hash = 0x811c9dc5;
  for (const letter of title.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()) {
    hash = Math.imul(hash ^ (letter.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return Math.floor((hash / 0x100000000) * CLOTH_COUNT) + 1;
}

/**
 * 1 (a short word or two) to 5 (a title that is nearly a paragraph): the longer the title, the smaller it is stamped
 * on the cover. Its longest word counts as well, so "Meditations" is not split in two at the size that suits eleven letters.
 */
export function coverTitleSize(title: string): 1 | 2 | 3 | 4 | 5 {
  const letters = Array.from(title.trim()).length;
  const longest = Math.max(0, ...title.split(/\s+/).map((word) => Array.from(word).length));
  const byLength = letters <= 14 ? 1 : letters <= 30 ? 2 : letters <= 60 ? 3 : letters <= 100 ? 4 : 5;
  const byWord = longest <= 8 ? 1 : longest <= 11 ? 2 : longest <= 14 ? 3 : longest <= 17 ? 4 : 5;
  return Math.max(byLength, byWord) as 1 | 2 | 3 | 4 | 5;
}

/** "40 min", "2 h 15 min", "6 h": a stretch of reading, in quarter hours past the first hour, as exact as an estimate can be. */
export function duration(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const rounded = totalMinutes >= 600 ? Math.round(totalMinutes / 60) * 60 : Math.round(totalMinutes / 15) * 15;
  const rest = rounded % 60;
  return rest === 0 ? `${rounded / 60} h` : `${Math.floor(rounded / 60)} h ${rest} min`;
}

/** What a book says about itself on the shelf. */
export type ReadingNote = {
  state: ReadingStatus;
  /** The short first line: "New", "35%", "Finished". */
  lead: string;
  /** The line under it: how long the book is, or how much of it is left. */
  detail: string;
  /** How much of the progress bar is filled, 0 to 100. */
  percent: number;
};

/** Manual reading status and separate position, so reaching the end never claims the reader finished. */
export function readingNote(book: BookSummary): ReadingNote {
  const { progress, readingStatus } = book;
  const percent = progress?.percent ?? 0;
  if (readingStatus === "finished") return { state: "finished", lead: "Finished", detail: progress && percent > 0 ? `Last place: ${percent}%` : "", percent };
  if (readingStatus === "saved") {
    const detail = !progress ? `${duration(minutes(book.wordCount))} to read` : percent > 0 ? `${percent}% through` : "At the beginning";
    return { state: "saved", lead: "Saved for later", detail, percent };
  }
  if (!progress) return { state: "reading", lead: "New", detail: `${duration(minutes(book.wordCount))} to read`, percent: 0 };
  if (percent >= 100) return { state: "reading", lead: "100%", detail: "At end of book", percent: 100 };
  const left = minutes(book.wordCount * (1 - progress.percent / 100));
  return {
    state: "reading",
    // A book opened but not yet scrolled has no percentage worth printing.
    lead: progress.percent > 0 ? `${progress.percent}%` : "Just started",
    detail: `${duration(left)} left`,
    percent: progress.percent,
  };
}

/** The book marked Reading and opened most recently: its position is not a completion verdict. */
export function latestRead(books: BookSummary[]): StartedBook | null {
  let latest: StartedBook | null = null;
  for (const book of books) {
    const { progress } = book;
    if (!progress || book.readingStatus !== "reading") continue;
    if (!latest || progress.updatedAt > latest.progress.updatedAt) latest = { ...book, progress };
  }
  return latest;
}

/** The shelf in its two parts: pinned books, the one pinned last first (ties by id), and the rest in the order they came in. */
export function splitPinned(books: BookSummary[]): { pinned: BookSummary[]; rest: BookSummary[] } {
  // Plain comparison, not localeCompare: the same times and ids must sort the same in every language the reader uses.
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const pinned = books
    .filter((book): book is BookSummary & { pinnedAt: string } => book.pinnedAt !== undefined)
    .sort((a, b) => order(b.pinnedAt, a.pinnedAt) || order(a.id, b.id));
  return { pinned, rest: books.filter((book) => book.pinnedAt === undefined) };
}

/** Match shelf titles and authors, preserving the shelf's order. */
export function filterBooks(books: BookSummary[], query: string, status: ReadingStatus | "all" = "all"): BookSummary[] {
  const text = query.trim().toLowerCase();
  return books.filter((book) => (status === "all" || book.readingStatus === status) && (!text || `${book.title}\n${book.author ?? ""}`.toLowerCase().includes(text)));
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
