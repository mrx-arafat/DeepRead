import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { BookDetail, Chapter } from "../../shared/types.ts";
import { api } from "../api.ts";
import { bookPercent } from "./book.ts";
import { blockOf } from "./textRanges.ts";

export type ReadingPosition = {
  /** The chapter at the top of the window. */
  chapterId: string | null;
  /** How much of the whole book lies above the top of the window, 0 to 100. */
  percent: number;
};

type Spot = { chapter: HTMLElement; block: HTMLElement | null };

/** Where the reader's eyes are: just under the top bar. */
const EYE_LINE = 96;

/** The book block and chapter section at the eye line. */
function spotAtEyeLine(): Spot | null {
  const column = document.querySelector(".chapter-text")?.getBoundingClientRect();
  if (!column) return null;
  const x = column.left + 24;
  // Look a little lower too, so the space between two paragraphs is not a miss.
  for (const y of [EYE_LINE, EYE_LINE + 24, EYE_LINE + 48]) {
    const hit = document.elementFromPoint(x, y);
    // A note under its paragraph (small screens) counts as that paragraph.
    const block = blockOf(hit) ?? hit?.closest(".row")?.querySelector<HTMLElement>("[data-block]") ?? null;
    const chapter = block?.closest<HTMLElement>("[data-chapter]");
    if (block && chapter) return { chapter, block };
  }
  const chapter = document.elementFromPoint(x, EYE_LINE)?.closest<HTMLElement>("[data-chapter]");
  return chapter ? { chapter, block: null } : null;
}

/** The book block at the top of the window, if any. */
export function blockAtTop(): HTMLElement | null {
  return spotAtEyeLine()?.block ?? null;
}

/** How far into its chapter the spot is, 0 to 1, or null when that cannot be told (between two paragraphs). */
function fractionRead({ chapter, block }: Spot): number | null {
  if (block) {
    const blocks = Array.from(chapter.querySelectorAll("[data-block]"));
    return blocks.indexOf(block) / blocks.length;
  }
  // Off the text: the heading and preview come before it, the recap after it.
  const text = chapter.querySelector(".chapter-text")?.getBoundingClientRect();
  if (!text || text.top > EYE_LINE) return 0;
  return text.bottom < EYE_LINE ? 1 : null;
}

/** Scrolled to the very bottom with the book's last chapter on the page: the whole book has been read. */
function atBookEnd(book: BookDetail): boolean {
  const last = book.chapters.at(-1);
  return (
    last !== undefined &&
    window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2 &&
    document.querySelector(`[data-chapter="${CSS.escape(last.id)}"]`) !== null
  );
}

/**
 * Follows the reader through the book: the chapter and whole-book percentage at the top of the window, reading
 * progress saved to the server, and the URL kept on the current chapter so a reload reopens it.
 * Each time the book (re)starts at `first`, it also sets the opening scroll position.
 */
export function useReadingPosition(
  bookId: string,
  chapterId: string | null,
  book: BookDetail | null,
  first: Chapter | undefined,
): ReadingPosition {
  const [, navigate] = useLocation();
  const [position, setPosition] = useState<ReadingPosition>({ chapterId: null, percent: 0 });
  // The newest progress saved from this page; the copy in `book` is only as fresh as the page load.
  const saved = useRef<{ chapterId: string; blockId: string } | null>(null);
  const opened = useRef<Chapter | null>(null);
  const inUrl = useRef(chapterId);

  useEffect(() => {
    inUrl.current = chapterId;
  }, [chapterId]);

  // Open where the reader left off if that is in the chapter the book starts at; otherwise at the top.
  // Once per start: appended chapters leave `first` as it is.
  useEffect(() => {
    if (!book || !first || opened.current === first) return;
    opened.current = first;
    const progress = saved.current ?? book.progress;
    const element =
      progress?.chapterId === first.id && document.querySelector(`[data-block="${CSS.escape(progress.blockId)}"]`);
    if (element) element.scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0 });
  }, [book, first]);

  useEffect(() => {
    if (!book || !first) {
      setPosition((prev) => (prev.chapterId === null ? prev : { ...prev, chapterId: null }));
      return;
    }
    let measuring: number | undefined;
    let saving: number | undefined;
    let savedBlock: string | null = null;

    const measure = () => {
      measuring = undefined;
      const spot = spotAtEyeLine();
      const id = spot?.chapter.dataset.chapter;
      const fraction = spot ? fractionRead(spot) : null;
      if (!id || fraction === null) return;
      const percent = atBookEnd(book) ? 100 : bookPercent(book.chapters, book.wordCount, id, fraction);
      // Unchanged rounded values keep the same state object, so scrolling does not re-render the book.
      setPosition((prev) => (prev.chapterId === id && prev.percent === percent ? prev : { chapterId: id, percent }));
      // A URL chapter that is not on the page is still being opened: leave the URL to it.
      const current = inUrl.current;
      if (current && id !== current && document.querySelector(`[data-chapter="${CSS.escape(current)}"]`)) {
        navigate(`/book/${bookId}/${id}`, { replace: true });
      }
    };

    const save = () => {
      const spot = spotAtEyeLine();
      const blockId = spot?.block?.dataset.block;
      const id = spot?.chapter.dataset.chapter;
      if (!blockId || !id || blockId === savedBlock) return;
      savedBlock = blockId;
      saved.current = { chapterId: id, blockId };
      api.saveProgress(bookId, id, blockId).catch(() => {
        // Progress is a convenience; reading must not be interrupted if saving fails.
      });
    };

    const onScroll = () => {
      measuring ??= window.setTimeout(measure, 150);
      window.clearTimeout(saving);
      saving = window.setTimeout(save, 1200);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(measuring);
      window.clearTimeout(saving);
    };
  }, [book, first, bookId, navigate]);

  return position;
}
