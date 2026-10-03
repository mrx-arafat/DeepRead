import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useLocation } from "wouter";
import type { BookDetail, Chapter } from "../../shared/types.ts";
import { api } from "../api.ts";
import { nextInFlow, openingChapter, previousInFlow } from "./book.ts";

export type ChapterFlow = {
  /** The chapters on the page, in book order. */
  chapters: Chapter[];
  /** The chapter the book was opened at: the same object until the reader opens another part of the book. */
  start: Chapter | undefined;
  /** Why the opening chapter could not be shown. */
  error: string | null;
  /** More chapters follow the last one on the page. */
  hasMore: boolean;
  loadingNext: boolean;
  nextError: string | null;
  loadNext: () => void;
  /** Goes after the last chapter: coming near it loads the next one. */
  sentinel: RefObject<HTMLParagraphElement | null>;
  /** Chapters come before the first one on the page. */
  hasEarlier: boolean;
  loadingPrevious: boolean;
  previousError: string | null;
  loadPrevious: () => void;
  /** Goes before the first chapter: coming near it puts the one before above the reader. */
  topSentinel: RefObject<HTMLParagraphElement | null>;
};

/** Generous, so the next chapter is usually on the page before the reader gets there. */
const LOOK_AHEAD = "0px 0px 1500px 0px";
const LOOK_BEHIND = "1500px 0px 0px 0px";

/**
 * Runs `change`, which puts a chapter above the one with `chapterId`, and scrolls by the height it added, so the text
 * on screen does not move. Synchronous, so the reader never sees a jump. The browser's own scroll anchoring is off
 * meanwhile: it does not act at the very top of the page, and where it does, it would move the text a second time.
 */
function keepInPlace(chapterId: string, change: () => void): void {
  // Its text, not its top edge: the space above that edge changes along with the chapters above.
  const section = document.querySelector(`[data-chapter="${CSS.escape(chapterId)}"]`);
  const anchor = section?.querySelector("[data-block]") ?? section;
  const root = document.documentElement;
  const before = anchor?.getBoundingClientRect().top;
  root.style.overflowAnchor = "none";
  flushSync(change);
  if (anchor && before !== undefined) window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: "instant" });
  requestAnimationFrame(() => root.style.removeProperty("overflow-anchor"));
}

type Way = "previous" | "next";

/**
 * The whole book as one continuous read: opens at a chapter, appends the following ones as the reader nears the end
 * and puts the earlier ones above as they near the top, so they can scroll back into the end of the chapter before.
 */
export function useChapterFlow(bookId: string, chapterId: string | null, book: BookDetail | null): ChapterFlow {
  const [, navigate] = useLocation();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [start, setStart] = useState<Chapter | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loadingNext, setLoadingNext] = useState(false);
  const [nextError, setNextError] = useState<string | null>(null);
  const [loadingPrevious, setLoadingPrevious] = useState(false);
  const [previousError, setPreviousError] = useState<string | null>(null);
  // Read synchronously by the guards below, where state would still hold the previous render's value.
  const shown = useRef<Chapter[]>([]);
  const request = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLParagraphElement | null>(null);
  const topSentinel = useRef<HTMLParagraphElement | null>(null);

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
    const target = book.progress?.chapterId ?? openingChapter(book.chapters)?.id;
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
    setStart(undefined);
    setError(null);
    setNextError(null);
    setLoadingNext(false);
    setPreviousError(null);
    setLoadingPrevious(false);
    api
      .getChapter(bookId, chapterId, controller.signal)
      .then((chapter) => {
        if (request.current !== controller) return;
        request.current = null;
        show([chapter]);
        setStart(chapter);
      })
      .catch((err: Error) => {
        if (request.current !== controller) return;
        request.current = null;
        setError(err.message);
      });
  }, [bookId, chapterId, show]);

  const first = chapters[0];
  const last = chapters.at(-1);
  const hasMore = book !== null && last !== undefined && nextInFlow(book.chapters, last.id) !== undefined;
  const hasEarlier = book !== null && first !== undefined && previousInFlow(book.chapters, first.id) !== undefined;

  const load = useCallback(
    (way: Way) => {
      // One request at a time: a second call while one is out (or while the opening chapter loads) does nothing.
      const edge = way === "next" ? shown.current.at(-1) : shown.current[0];
      if (!book || !edge || request.current) return;
      const target = way === "next" ? nextInFlow(book.chapters, edge.id) : previousInFlow(book.chapters, edge.id);
      if (!target) return;
      const setLoading = way === "next" ? setLoadingNext : setLoadingPrevious;
      const setFailed = way === "next" ? setNextError : setPreviousError;
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setFailed(null);
      api
        .getChapter(bookId, target.id, controller.signal)
        .then((chapter) => {
          // Dropped when the book was restarted from another chapter meanwhile.
          if (request.current !== controller) return;
          request.current = null;
          if (way === "next") {
            setLoading(false);
            show([...shown.current, chapter]);
            return;
          }
          keepInPlace(edge.id, () => {
            setLoading(false);
            show([chapter, ...shown.current]);
          });
        })
        .catch((err: Error) => {
          if (request.current !== controller) return;
          request.current = null;
          setLoading(false);
          setFailed(err.message);
        });
    },
    [book, bookId, show],
  );

  const loadNext = useCallback(() => load("next"), [load]);
  const loadPrevious = useCallback(() => load("previous"), [load]);

  // A fresh observer after every change: it reports at once, so a short chapter that leaves a sentinel in view
  // still pulls in the one after (or before) it.
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

  useEffect(() => {
    const target = topSentinel.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadPrevious();
      },
      { rootMargin: LOOK_BEHIND },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [chapters, hasEarlier, previousError, loadPrevious]);

  return {
    chapters,
    start,
    error,
    hasMore,
    loadingNext,
    nextError,
    loadNext,
    sentinel,
    hasEarlier,
    loadingPrevious,
    previousError,
    loadPrevious,
    topSentinel,
  };
}
