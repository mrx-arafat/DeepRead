import { useEffect } from "react";
import { shortTitle } from "./library/bookText.ts";

export const APP_NAME = "DeepRead";

/** The title of a reader tab: the book, then the chapter being read. Each is cut short, as a tab only has room for the start. */
export function readerTitle(bookTitle: string | undefined, chapterTitle: string | undefined): string {
  const book = bookTitle ? shortTitle(bookTitle, 40) : "";
  const chapter = chapterTitle ? shortTitle(chapterTitle, 40) : "";
  // A one-chapter book often names its only chapter after itself; saying it twice would just waste the tab.
  if (!book) return APP_NAME;
  return chapter && chapter.toLowerCase() !== book.toLowerCase() ? `${book} - ${chapter}` : book;
}

/** Puts `title` on the browser tab and in the history menu, where several DeepRead pages would otherwise look alike. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
