import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { BookDetail, Chapter, ReadingProgress } from "../../shared/types.ts";
import { api } from "../api.ts";
import { bookPercent, indexAtLine, lastOfText } from "./book.ts";

export type ReadingPosition = {
  /** The chapter at the top of the window. */
  chapterId: string | null;
  /** How much of the whole book lies above the top of the window, 0 to 100. */
  percent: number;
};

/** The chapter at the eye line, and the block there or next below it; no block once its text is behind the reader. */
type Spot = { chapter: HTMLElement; block: HTMLElement | null; blocks: NodeListOf<HTMLElement> };

/** Where the reader's eyes are: just under the top bar. */
export const EYE_LINE = 96;

const bottomOf = (elements: NodeListOf<HTMLElement>, row: boolean) => (index: number) => {
  const element = elements[index];
  // A note under its paragraph (small screens) counts as part of that paragraph.
  return (row ? (element?.closest(".row") ?? element) : element)?.getBoundingClientRect().bottom ?? 0;
};

/**
 * The chapter and block at the eye line, found by their positions so that anything over the text (the way back
 * to earlier chapters, a popover, the chapter list) cannot hide them.
 */
function spotAtEyeLine(): Spot | null {
  const chapters = document.querySelectorAll<HTMLElement>("[data-chapter]");
  if (chapters.length === 0) return null;
  // Above the first chapter on the page counts as its start, below the last as its end.
  const chapter = chapters[Math.min(indexAtLine(chapters.length, bottomOf(chapters, false), EYE_LINE), chapters.length - 1)];
  if (!chapter) return null;
  const blocks = chapter.querySelectorAll<HTMLElement>("[data-block]");
  return { chapter, block: blocks[indexAtLine(blocks.length, bottomOf(blocks, true), EYE_LINE)] ?? null, blocks };
}

/** The book block at the top of the window, if any. */
export function blockAtTop(): HTMLElement | null {
  return spotAtEyeLine()?.block ?? null;
}

/** A range over the character at `offset`, moved on past spaces: one where a line wraps may have no box of its own. */
function charRange(text: Text, offset: number): Range {
  let at = Math.min(Math.max(offset, 0), text.length - 1);
  while (at < text.length - 1 && /\s/.test(text.data.charAt(at))) at++;
  const range = document.createRange();
  range.setStart(text, at);
  range.setEnd(text, at + 1);
  return range;
}

/** Where the line at `line` (px from the window top) starts in `block`'s text, in characters. */
function offsetAtLine(block: HTMLElement, line: number): number {
  const text = block.firstChild;
  if (!(text instanceof Text)) return 0;
  return indexAtLine(text.length, (index) => charRange(text, index).getBoundingClientRect().bottom, line);
}

/** How far down the window the line holding character `offset` of `block` is, in px. */
function lineTop(block: HTMLElement, offset: number): number {
  const text = block.firstChild;
  return text instanceof Text ? charRange(text, offset).getBoundingClientRect().top : block.getBoundingClientRect().top;
}

/** How far into its chapter the spot is, 0 to 1. Above the text (heading, preview) is 0; the recap after it is 1. */
function fractionRead({ block, blocks }: Spot): number {
  return block ? Array.prototype.indexOf.call(blocks, block) / blocks.length : 1;
}

/** Scrolled to the very bottom with the book's last chapter on the page: the whole book has been read. */
function atBookEnd(book: BookDetail): boolean {
  const last = lastOfText(book.chapters);
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
  const saved = useRef<Pick<ReadingProgress, "chapterId" | "blockId" | "offset"> | null>(null);
  const opened = useRef<Chapter | null>(null);
  const inUrl = useRef(chapterId);

  // A layout effect: a measurement already waiting on a timer must see a chapter the reader just jumped to.
  useLayoutEffect(() => {
    inUrl.current = chapterId;
  }, [chapterId]);

  // Open where the reader left off if that is in the chapter the book starts at; otherwise at the top.
  // Once per start: appended chapters leave `first` as it is.
  useEffect(() => {
    if (!book || !first || opened.current === first) return;
    opened.current = first;
    const progress = saved.current ?? book.progress;
    const element =
      progress?.chapterId === first.id && document.querySelector<HTMLElement>(`[data-block="${CSS.escape(progress.blockId)}"]`);
    if (element) {
      element.scrollIntoView({ block: "start" });
      // Then on to the reader's line, so it lands where the paragraph's first line would. Progress saved before
      // lines were kept has no offset and opens at the paragraph.
      window.scrollBy(0, lineTop(element, progress.offset ?? 0) - lineTop(element, 0));
    } else window.scrollTo({ top: 0 });
  }, [book, first]);

  useEffect(() => {
    if (!book || !first) {
      // While a chapter opens, the top bar already names it and where it starts in the book.
      const id = book && inUrl.current;
      const opening = id ? { chapterId: id, percent: bookPercent(book.chapters, id, 0) } : { chapterId: null, percent: 0 };
      setPosition((prev) => (prev.chapterId === opening.chapterId && prev.percent === opening.percent ? prev : opening));
      return;
    }
    let measuring: number | undefined;
    let saving: number | undefined;

    const measure = () => {
      measuring = undefined;
      const spot = spotAtEyeLine();
      const id = spot?.chapter.dataset.chapter;
      if (!spot || !id) return;
      const percent = atBookEnd(book) ? 100 : bookPercent(book.chapters, id, fractionRead(spot));
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
      const block = spot?.block;
      const blockId = block?.dataset.block;
      const id = spot?.chapter.dataset.chapter;
      if (!block || !blockId || !id) return;
      const offset = offsetAtLine(block, EYE_LINE);
      if (saved.current?.blockId === blockId && saved.current.offset === offset) return;
      saved.current = { chapterId: id, blockId, offset };
      api.saveProgress(bookId, id, blockId, offset).catch(() => {
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
