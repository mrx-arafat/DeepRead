import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useLocation } from "wouter";
import type { BookDetail, Chapter } from "../../shared/types.ts";
import { tierParams } from "../deviceTier.ts";
import { nextInFlow, openingChapter, previousInFlow } from "./book.ts";
import { cachedChapter, chapterCache, chapterKey, loadChapter } from "./chapterCache.ts";
import { pinnedChapters } from "./mountRegistry.ts";

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
 * How far past the window a chapter must lie before the flow lets it go: twice the look margin above, so that
 * dropping it never brings a sentinel back within reach, which would load the same chapter again at once.
 */
const TRIM_CLEARANCE = 3000;

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
type End = "start" | "end";

/**
 * The chapters to keep once `chapters` has grown past `cap`: the far end is cut back, chapter by chapter, until the
 * cap holds or a kept chapter is reached. The flow is one contiguous run of the book, so it never cuts a hole in the
 * middle; a kept chapter near the far end means the list stays over the cap for now. The same array comes back when
 * nothing is dropped, so callers can tell.
 */
export function trimKnown(chapters: Chapter[], cap: number, kept: ReadonlySet<string>, from: End): Chapter[] {
  let drop = 0;
  while (chapters.length - drop > cap) {
    const edge = from === "start" ? chapters[drop] : chapters[chapters.length - 1 - drop];
    if (!edge || kept.has(edge.id)) break;
    drop += 1;
  }
  if (drop === 0) return chapters;
  return from === "start" ? chapters.slice(drop) : chapters.slice(0, chapters.length - drop);
}

/**
 * The chapters the flow must keep now: those holding a pinned block (a sentence being read aloud, a word card, a
 * source visit) and those not yet clear of the window on the side being trimmed, the one being read among them.
 * A chapter whose section is not on the page is kept too: what cannot be measured is not dropped.
 */
function keptNow(chapters: Chapter[], from: End): Set<string> {
  const kept = new Set(pinnedChapters());
  for (const chapter of chapters) {
    if (kept.has(chapter.id)) continue;
    const section = document.querySelector(`[data-chapter="${CSS.escape(chapter.id)}"]`);
    if (!section) {
      kept.add(chapter.id);
      continue;
    }
    const box = section.getBoundingClientRect();
    const clear = from === "start" ? box.bottom < -TRIM_CLEARANCE : box.top > window.innerHeight + TRIM_CLEARANCE;
    if (!clear) kept.add(chapter.id);
  }
  return kept;
}

/**
 * The whole book as one continuous read: opens at a chapter, appends the following ones as the reader nears the end
 * and puts the earlier ones above as they near the top, so they can scroll back into the end of the chapter before.
 * The page keeps a bounded run of chapters: past the tier's cap the far end goes, and comes back from the cache when
 * the reader returns to it.
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
  // The chapter in the URL, read where state would be stale, so `load` need not change with every scroll.
  const inUrl = useRef(chapterId);
  // The look-ahead request out now, and the other way asked for meanwhile: one at a time, the other after it.
  const prefetching = useRef<AbortController | null>(null);
  const wanted = useRef<Way | null>(null);

  useLayoutEffect(() => {
    inUrl.current = chapterId;
  }, [chapterId]);

  const show = useCallback((next: Chapter[]) => {
    shown.current = next;
    setChapters(next);
  }, []);

  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
      prefetching.current?.abort();
      prefetching.current = null;
    },
    [],
  );

  /**
   * Asks for the chapter after the last one (or before the first) and keeps it in the cache, so that mounting it
   * later is a cache hit: the mount sentinels sit 1500px out, less than one fetch on a slow connection, and the
   * reader would otherwise wait at the chapter's end. Nothing on the page changes, and a failure says nothing: the
   * mount asks again in its own right.
   */
  const prefetch = useCallback(
    function prefetch(way: Way): void {
      if (!book) return;
      if (prefetching.current) {
        wanted.current = way;
        return;
      }
      const edge = way === "next" ? shown.current.at(-1) : shown.current[0];
      const target = edge && (way === "next" ? nextInFlow(book.chapters, edge.id) : previousInFlow(book.chapters, edge.id));
      if (!target || chapterCache.has(chapterKey(bookId, target.id))) return;
      const controller = new AbortController();
      prefetching.current = controller;
      loadChapter(bookId, target.id, controller.signal)
        .catch(() => {})
        .then(() => {
          if (prefetching.current !== controller) return;
          prefetching.current = null;
          const again = wanted.current;
          wanted.current = null;
          if (again) prefetch(again);
        });
    },
    [book, bookId],
  );

  // No chapter in the URL: continue where the reader stopped, or start at the beginning.
  useEffect(() => {
    if (chapterId || !book) return;
    const target = book.progress?.chapterId ?? openingChapter(book.chapters)?.id;
    if (target) navigate(`/book/${bookId}/${target}`, { replace: true });
    else setError("This book has no chapters to read.");
  }, [book, bookId, chapterId, navigate]);

  // The URL follows the reader through the chapters on the page, so a chapter that is already here needs nothing.
  // Any other chapter starts the book over from there. A layout effect: a chapter the cache still holds is shown in
  // the same frame, so the reader never sees "Opening the chapter..." on the way back to it.
  useLayoutEffect(() => {
    if (!chapterId || shown.current.some((chapter) => chapter.id === chapterId)) return;
    request.current?.abort();
    request.current = null;
    // A neighbour of where the reader was is no use where they are going.
    prefetching.current?.abort();
    prefetching.current = null;
    wanted.current = null;
    setError(null);
    setNextError(null);
    setLoadingNext(false);
    setPreviousError(null);
    setLoadingPrevious(false);
    const kept = cachedChapter(bookId, chapterId);
    if (kept) {
      // A fresh object each time the book starts here: `start` tells one opening from the next by identity.
      const chapter = { ...kept };
      show([chapter]);
      setStart(chapter);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    show([]);
    setStart(undefined);
    loadChapter(bookId, chapterId, controller.signal)
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
      loadChapter(bookId, target.id, controller.signal)
        .then((chapter) => {
          // Dropped when the book was restarted from another chapter meanwhile.
          if (request.current !== controller) return;
          request.current = null;
          const cap = tierParams().knownChapters;
          if (way === "next") {
            const grown = [...shown.current, chapter];
            const next = grown.length > cap ? trimKnown(grown, cap, keptNow(grown, "start"), "start") : grown;
            if (next === grown) {
              setLoading(false);
              show(next);
              return;
            }
            // Chapters above go with the one below arriving: the first kept chapter's text stays where it is.
            keepInPlace(next[0]!.id, () => {
              setLoading(false);
              show(next);
            });
            // The URL named a dropped chapter: point it at the page until the reading position names the right one.
            if (inUrl.current && !next.some((item) => item.id === inUrl.current)) {
              navigate(`/book/${bookId}/${next[0]!.id}`, { replace: true, state: history.state });
            }
            return;
          }
          const grown = [chapter, ...shown.current];
          const next = grown.length > cap ? trimKnown(grown, cap, keptNow(grown, "end"), "end") : grown;
          keepInPlace(edge.id, () => {
            setLoading(false);
            show(next);
          });
          if (inUrl.current && !next.some((item) => item.id === inUrl.current)) {
            navigate(`/book/${bookId}/${next.at(-1)!.id}`, { replace: true, state: history.state });
          }
        })
        .catch((err: Error) => {
          if (request.current !== controller) return;
          request.current = null;
          setLoading(false);
          setFailed(err.message);
        });
    },
    [book, bookId, navigate, show],
  );

  const loadNext = useCallback(() => load("next"), [load]);
  const loadPrevious = useCallback(() => load("previous"), [load]);

  // Ahead of the mount sentinels: the next chapter's text is asked for as the reader passes the middle of the last
  // chapter on the page, and the previous one's at the middle of the first, so each mount later is a cache hit.
  // The middle is found by a chunk of text, which has a box on every tier (the chunk itself where it is a
  // placeholder, else its first block), and failing that the chapter's section.
  useEffect(() => {
    if (!book || chapters.length === 0) return;
    const observers: IntersectionObserver[] = [];
    const watch = (chapter: Chapter, way: Way) => {
      const section = document.querySelector(`[data-chapter="${CSS.escape(chapter.id)}"]`);
      if (!section) return;
      const chunks = section.querySelectorAll(".text-chunk");
      const middle = chunks[Math.floor(chunks.length / 2)];
      const target = middle?.querySelector("[data-block]") ?? middle ?? section;
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        prefetch(way);
      });
      observer.observe(target);
      observers.push(observer);
    };
    if (hasMore && last) watch(last, "next");
    if (hasEarlier && first) watch(first, "previous");
    return () => {
      for (const observer of observers) observer.disconnect();
    };
  }, [book, chapters, first, last, hasMore, hasEarlier, prefetch]);

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
