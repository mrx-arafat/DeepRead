import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useLocation } from "wouter";
import type { BookDetail, Chapter, ChapterSummary } from "../../shared/types.ts";
import { api } from "../api.ts";

export type ChapterFlow = {
  /** The chapters on the page, in book order, from the one the reader opened onwards. */
  chapters: Chapter[];
  /** Why the opening chapter could not be shown. */
  error: string | null;
  /** The chapter before the first one on the page, if any. */
  previous: ChapterSummary | undefined;
  /** More chapters follow the last one on the page. */
  hasMore: boolean;
  loadingNext: boolean;
  nextError: string | null;
  loadNext: () => void;
  /** Goes after the last chapter: coming near it loads the next one. */
  sentinel: RefObject<HTMLParagraphElement | null>;
};

/** Generous, so the next chapter is usually on the page before the reader gets there. */
const LOOK_AHEAD = "0px 0px 1500px 0px";

/** The whole book as one continuous read: opens at a chapter and appends the following ones as the reader nears the end. */
export function useChapterFlow(bookId: string, chapterId: string | null, book: BookDetail | null): ChapterFlow {
  const [, navigate] = useLocation();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingNext, setLoadingNext] = useState(false);
  const [nextError, setNextError] = useState<string | null>(null);
  // Read synchronously by the guards below, where state would still hold the previous render's value.
  const shown = useRef<Chapter[]>([]);
  const request = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLParagraphElement | null>(null);

  const show = useCallback((next: Chapter[]) => {
    shown.current = next;
    setChapters(next);
  }, []);

  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [],
  );

  // No chapter in the URL: continue where the reader stopped, or start at the beginning.
  useEffect(() => {
    if (chapterId || !book) return;
    const target = book.progress?.chapterId ?? book.chapters[0]?.id;
    if (target) navigate(`/book/${bookId}/${target}`, { replace: true });
    else setError("This book has no chapters to read.");
  }, [book, bookId, chapterId, navigate]);

  // The URL follows the reader through the chapters on the page, so a chapter that is already here needs nothing.
  // Any other chapter starts the book over from there.
  useEffect(() => {
    if (!chapterId || shown.current.some((chapter) => chapter.id === chapterId)) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    show([]);
    setError(null);
    setNextError(null);
    setLoadingNext(false);
    api
      .getChapter(bookId, chapterId, controller.signal)
      .then((chapter) => {
        if (request.current !== controller) return;
        request.current = null;
        show([chapter]);
      })
      .catch((err: Error) => {
        if (request.current !== controller) return;
        request.current = null;
        setError(err.message);
      });
  }, [bookId, chapterId, show]);

  const last = chapters.at(-1);
  const lastIndex = book && last ? book.chapters.findIndex((item) => item.id === last.id) : -1;
  const firstIndex = book && chapters[0] ? book.chapters.findIndex((item) => item.id === chapters[0]?.id) : -1;
  const hasMore = book !== null && lastIndex !== -1 && lastIndex < book.chapters.length - 1;

  const loadNext = useCallback(() => {
    // One request at a time: a second call while one is out (or while the opening chapter loads) does nothing.
    const end = shown.current.at(-1);
    if (!book || !end || request.current) return;
    const at = book.chapters.findIndex((item) => item.id === end.id);
    const next = at === -1 ? undefined : book.chapters[at + 1];
    if (!next) return;
    const controller = new AbortController();
    request.current = controller;
    setLoadingNext(true);
    setNextError(null);
    api
      .getChapter(bookId, next.id, controller.signal)
      .then((chapter) => {
        // Dropped when the book was restarted from another chapter meanwhile.
        if (request.current !== controller) return;
        request.current = null;
        setLoadingNext(false);
        show([...shown.current, chapter]);
      })
      .catch((err: Error) => {
        if (request.current !== controller) return;
        request.current = null;
        setLoadingNext(false);
        setNextError(err.message);
      });
  }, [book, bookId, show]);

  // A fresh observer after every append: it reports at once, so a short chapter that leaves the sentinel
  // in view still pulls in the one after it.
  useEffect(() => {
    const target = sentinel.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNext();
      },
      { rootMargin: LOOK_AHEAD },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [chapters, hasMore, nextError, loadNext]);

  return {
    chapters,
    error,
    previous: book && firstIndex > 0 ? book.chapters[firstIndex - 1] : undefined,
    hasMore,
    loadingNext,
    nextError,
    loadNext,
    sentinel,
  };
}
