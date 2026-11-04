import { api } from "../api.ts";
import { loadReader } from "../loadReader.ts";
import { loadChapter } from "../reader/chapterCache.ts";

/**
 * Starts what the reader page asks for first, as a book is opened from the library: its details, and the chapter it
 * opens at when that is known (the reader's place in it, or the book's opening chapter while it has none). The page
 * joins these requests rather than making its own once it has drawn, and the chapter no longer waits for the details
 * to say which one it is.
 */
export function startOpening(bookId: string, chapterId?: string): void {
  // Nearly always in already: the library asks for it once the shelf is up.
  loadReader().catch(() => {});
  api.prefetchBook(bookId);
  // A failure is the page's to report: it asks for the chapter again in its own right.
  if (chapterId) loadChapter(bookId, chapterId).catch(() => {});
}
