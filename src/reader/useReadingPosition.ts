import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { BookDetail, Chapter, ReadingProgress } from "../../shared/types.ts";
import { api } from "../api.ts";
import { bookPercent, chapterMinutesLeft, indexAtLine } from "./book.ts";
import { inPages, pageFrame } from "./paging.ts";

export type ReadingPosition = {
  /** The chapter at the top of the window. */
  chapterId: string | null;
  /** How much of the whole book lies above the top of the window, 0 to 100. */
  percent: number;
  /** About how many minutes of that chapter are left to read; null until it is measured. */
  minutesLeft: number | null;
  /** The closing panel has entered the visible reading area. */
  completed: boolean;
};

/** The chapter at the eye line, and the block there or next below it; no block once its text is behind the reader. */
type Spot = { chapter: HTMLElement; block: HTMLElement | null; blocks: NodeListOf<HTMLElement> };

/** Where the reader's eyes are: just under the top bar. */
export const EYE_LINE = 96;

/** The eye line now: in pages, the first line of the page, so the place kept is the line a reopened page starts on. */
export const eyeLine = (): number => (inPages() ? pageFrame().top + 2 : EYE_LINE);

const bottomOf = (elements: NodeListOf<HTMLElement>, part: (element: HTMLElement) => Element | null) => (index: number) => {
  const element = elements[index];
  return element ? (part(element) ?? element).getBoundingClientRect().bottom : 0;
};

// The empty space after a chapter's last box leads into the next chapter, so it counts as that one's start.
const chapterContent = (chapter: HTMLElement) => chapter.lastElementChild;
// A note under its paragraph (small screens) counts as part of that paragraph.
const blockRow = (block: HTMLElement) => block.closest(".row");

/**
 * The chapter and block at the eye line, found by their positions so that anything over the text (the way back
 * to earlier chapters, a popover, the chapter list) cannot hide them.
 */
function spotAtEyeLine(): Spot | null {
  const chapters = document.querySelectorAll<HTMLElement>("[data-chapter]");
  if (chapters.length === 0) return null;
  // Above the first chapter on the page counts as its start, below the last as its end.
  const at = indexAtLine(chapters.length, bottomOf(chapters, chapterContent), eyeLine());
  const chapter = chapters[Math.min(at, chapters.length - 1)];
  if (!chapter) return null;
  const blocks = chapter.querySelectorAll<HTMLElement>("[data-block]");
  return { chapter, block: blocks[indexAtLine(blocks.length, bottomOf(blocks, blockRow), eyeLine())] ?? null, blocks };
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

// The place the last text size change kept on screen. Until the reader scrolls, the next change keeps that same
// place: taking the start of the line it reflowed into instead would creep back through the text with every tap.
let kept: { block: HTMLElement; offset: number; scrollY: number } | null = null;

/**
 * Runs `change`, which reflows the book (a new text size), then scrolls so that the line the reader is on stays where
 * it was on screen, as in an e-reader. The browser's own scroll anchoring does not hold it through a text size change.
 */
export function keepingLine(change: () => void): void {
  const again = kept?.block.isConnected && kept.scrollY === window.scrollY ? kept : null;
  const block = again?.block ?? blockAtTop();
  if (!block) return change();
  const offset = again?.offset ?? offsetAtLine(block, eyeLine());
  const top = lineTop(block, offset);
  change();
  window.scrollBy(0, lineTop(block, offset) - top);
  kept = { block, offset, scrollY: window.scrollY };
}

/** How far into its chapter the spot is, 0 to 1. Above the text (heading, preview) is 0; the recap after it is 1. */
function fractionRead({ block, blocks }: Spot): number {
  return block ? Array.prototype.indexOf.call(blocks, block) / blocks.length : 1;
}

/** The closing heading is wholly above the footer, so no chapter time remains to be read. */
function atBookEnd(): boolean {
  const heading = document.querySelector("#book-end-title");
  if (!heading) return false;
  const footerTop = document.querySelector(".reading-footer")?.getBoundingClientRect().top ?? window.innerHeight;
  return heading.getBoundingClientRect().bottom <= footerTop;
}

const same = (a: ReadingPosition, b: ReadingPosition) =>
  a.chapterId === b.chapterId && a.percent === b.percent && a.minutesLeft === b.minutesLeft && a.completed === b.completed;

type Place = Required<Pick<ReadingProgress, "chapterId" | "blockId" | "offset">>;

/** The block at the eye line and how far into it the line there starts. */
function placeAtEyeLine(): Place | null {
  const spot = spotAtEyeLine();
  const blockId = spot?.block?.dataset.block;
  const chapterId = spot?.chapter.dataset.chapter;
  if (!spot?.block || !blockId || !chapterId) return null;
  return { chapterId, blockId, offset: offsetAtLine(spot.block, eyeLine()) };
}

/**
 * The place kept with a page of the browser's history (its `history.state`), so that Back and Forward return to it.
 * The state may have been written by anything, so it is checked, not trusted.
 */
export function placeIn(state: unknown): Place | null {
  const place: unknown = typeof state === "object" && state !== null ? (state as { place?: unknown }).place : null;
  if (typeof place !== "object" || place === null) return null;
  const { chapterId, blockId, offset } = place as Record<string, unknown>;
  return typeof chapterId === "string" && typeof blockId === "string" && typeof offset === "number"
    ? { chapterId, blockId, offset }
    : null;
}

/** Safari refuses more than 100 history changes in 30 s; a refused one only costs what it would have kept. */
function changingHistory(change: () => void): void {
  try {
    change();
  } catch {
    // The place saved to the server still holds.
  }
}

/**
 * Follows the reader through the book: the chapter and whole-book percentage at the top of the window, reading
 * progress saved to the server, and the URL kept on the current chapter so a reload reopens it.
 * Each time the book (re)starts at `start`, it also sets the opening scroll position.
 */
export function useReadingPosition(
  bookId: string,
  chapterId: string | null,
  book: BookDetail | null,
  start: Chapter | undefined,
): ReadingPosition {
  const [, navigate] = useLocation();
  const [position, setPosition] = useState<ReadingPosition>({ chapterId: null, percent: 0, minutesLeft: null, completed: false });
  // The newest progress saved from this page; the copy in `book` is only as fresh as the page load.
  const saved = useRef<Place | null>(null);
  const opened = useRef<Chapter | null>(null);
  const inUrl = useRef(chapterId);

  // A layout effect: a measurement already waiting on a timer must see a chapter the reader just jumped to.
  useLayoutEffect(() => {
    inUrl.current = chapterId;
  }, [chapterId]);

  // The opening position below is the reader's place. Left to itself, the browser would scroll whatever chapter is
  // still on the page to the old offset on Back, before the chapter for that page of history has opened.
  useEffect(() => {
    history.scrollRestoration = "manual";
    return () => {
      history.scrollRestoration = "auto";
    };
  }, []);

  // Open where the reader left off if that is in the chapter the book starts at; otherwise at the top. Back or
  // Forward to a page of history returns to the place kept with it, not to where the reader went after it.
  // Once per start: chapters added above and below leave `start` as it is.
  useEffect(() => {
    if (!book || !start || opened.current === start) return;
    opened.current = start;
    const kept = placeIn(history.state);
    const progress = (kept?.chapterId === start.id ? kept : null) ?? saved.current ?? book.progress;
    const element =
      progress?.chapterId === start.id && document.querySelector<HTMLElement>(`[data-block="${CSS.escape(progress.blockId)}"]`);
    // A reader who stayed at the chapter's heading is saved at the very start of its text: that reopens at the heading.
    const atStart = element && !progress.offset && element.closest("[data-chapter]")?.querySelector("[data-block]") === element;
    if (element && !atStart) {
      element.scrollIntoView({ block: "start" });
      // Then on to the reader's line, so it lands where the paragraph's first line would. Progress saved before
      // lines were kept has no offset and opens at the paragraph.
      window.scrollBy(0, lineTop(element, progress.offset ?? 0) - lineTop(element, 0));
    } else window.scrollTo({ top: 0 });
  }, [book, start]);

  useEffect(() => {
    if (!book || !start) {
      // While a chapter opens, the top bar already names it and where it starts in the book.
      const id = book && inUrl.current;
      const opening: ReadingPosition = id
        ? { chapterId: id, percent: bookPercent(book.chapters, id, 0), minutesLeft: null, completed: false }
        : { chapterId: null, percent: 0, minutesLeft: null, completed: false };
      setPosition((prev) => (same(prev, opening) ? prev : opening));
      return;
    }
    let measuring: number | undefined;
    let keeping: number | undefined;
    let saving: number | undefined;

    const measure = () => {
      measuring = undefined;
      const spot = spotAtEyeLine();
      const id = spot?.chapter.dataset.chapter;
      if (!spot || !id) return;
      const fraction = fractionRead(spot);
      const completed = atBookEnd();
      const next: ReadingPosition = {
        chapterId: id,
        percent: completed ? 100 : bookPercent(book.chapters, id, fraction),
        minutesLeft: completed ? 0 : chapterMinutesLeft(book.chapters, id, fraction),
        completed,
      };
      // Unchanged rounded values keep the same state object, so scrolling does not re-render the book.
      setPosition((prev) => (same(prev, next) ? prev : next));
      // A URL chapter that is not on the page is still being opened: leave the URL to it.
      const current = inUrl.current;
      if (current && id !== current && document.querySelector(`[data-chapter="${CSS.escape(current)}"]`)) {
        changingHistory(() => navigate(`/book/${bookId}/${id}`, { replace: true, state: history.state }));
      }
    };

    // Soon after the reader stops, well before they could open the chapter list and jump elsewhere.
    const keep = () => {
      const place = placeAtEyeLine();
      if (place) changingHistory(() => history.replaceState({ ...history.state, place }, ""));
    };

    const save = () => {
      const place = placeAtEyeLine();
      if (!place || (saved.current?.blockId === place.blockId && saved.current.offset === place.offset)) return;
      saved.current = place;
      api.saveProgress(bookId, place.chapterId, place.blockId, place.offset).catch(() => {
        // Progress is a convenience; reading must not be interrupted if saving fails.
      });
    };

    const onScroll = () => {
      measuring ??= window.setTimeout(measure, 150);
      window.clearTimeout(keeping);
      keeping = window.setTimeout(keep, 300);
      window.clearTimeout(saving);
      saving = window.setTimeout(save, 1200);
    };

    measure();
    // Opening a chapter is being there, even for a reader who leaves without scrolling.
    keeping = window.setTimeout(keep, 300);
    saving = window.setTimeout(save, 1200);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(measuring);
      window.clearTimeout(keeping);
      window.clearTimeout(saving);
    };
  }, [book, start, bookId, navigate]);

  return position;
}
