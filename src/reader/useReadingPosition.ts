import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useHistoryState } from "wouter/use-browser-location";
import type { BookDetail, Chapter, ReadingProgress } from "../../shared/types.ts";
import { api } from "../api.ts";
import { bookPercent, chapterMinutesLeft, indexAtLine, textFraction } from "./book.ts";
import { inPages, pageFrame } from "./paging.ts";

type Position = {
  /** The chapter at the top of the window. */
  chapterId: string | null;
  /** How much of the whole book lies above the top of the window, 0 to 100. */
  percent: number;
  /** About how many minutes of that chapter are left to read; null until it is measured. */
  minutesLeft: number | null;
  /** The closing panel has entered the visible reading area. */
  completed: boolean;
};

export type ReadingPosition = Position & {
  detour: ReadingDetour | null;
  returning: boolean;
  detourError: string | null;
  visitPlace: (target: Place) => boolean;
  returnToPlace: () => void;
  cancelReturn: () => void;
  stayHere: () => void;
};

export interface ReadingDetour {
  bookId: string;
  returnTo: Place;
  returning?: boolean;
  from?: Place;
}

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
  return text instanceof Text && text.length > 0 ? charRange(text, offset).getBoundingClientRect().top : block.getBoundingClientRect().top;
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
  const beforeEye = eyeLine();
  change();
  const afterEye = eyeLine();
  window.scrollBy(0, lineTop(block, offset) - (beforeEye === afterEye ? top : afterEye));
  kept = { block, offset, scrollY: window.scrollY };
}

/**
 * How far into its chapter the spot is, 0 to 1, by the text above the line the reader is on (the server counts it the
 * same way, so the shelf agrees with the top bar). Above the text (heading, preview) is 0; the recap after it is 1.
 */
function fractionRead({ block, blocks }: Spot): number {
  if (!block) return 1;
  const lengths = Array.from(blocks, (each) => each.textContent?.length ?? 0);
  return textFraction(lengths, Array.prototype.indexOf.call(blocks, block), offsetAtLine(block, eyeLine()));
}

/** The closing heading is wholly above the footer, so no chapter time remains to be read. */
function atBookEnd(): boolean {
  const heading = document.querySelector("#book-end-title");
  if (!heading) return false;
  const footerTop = document.querySelector(".reading-footer")?.getBoundingClientRect().top ?? window.innerHeight;
  return heading.getBoundingClientRect().bottom <= footerTop;
}

const same = (a: Position, b: Position) =>
  a.chapterId === b.chapterId && a.percent === b.percent && a.minutesLeft === b.minutesLeft && a.completed === b.completed;

export type Place = Required<Pick<ReadingProgress, "chapterId" | "blockId" | "offset">>;

/** The block at the eye line and how far into it the line there starts. */
function placeOf(spot: Spot | null): Place | null {
  const blockId = spot?.block?.dataset.block;
  const chapterId = spot?.chapter.dataset.chapter;
  if (!spot?.block || !blockId || !chapterId) return null;
  return { chapterId, blockId, offset: offsetAtLine(spot.block, eyeLine()) };
}

const placeAtEyeLine = (): Place | null => placeOf(spotAtEyeLine());

/**
 * The place kept with a page of the browser's history (its `history.state`), so that Back and Forward return to it.
 * The state may have been written by anything, so it is checked, not trusted.
 */
export function placeIn(state: unknown): Place | null {
  const place: unknown = typeof state === "object" && state !== null ? (state as { place?: unknown }).place : null;
  if (typeof place !== "object" || place === null) return null;
  const { chapterId, blockId, offset } = place as Record<string, unknown>;
  return typeof chapterId === "string" && chapterId.length > 0 && typeof blockId === "string" && blockId.length > 0 && typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0
    ? { chapterId, blockId, offset }
    : null;
}

/** A deliberate source visit can restore only the validated return position belonging to this book. */
export function detourIn(state: unknown, bookId: string): ReadingDetour | null {
  if (!state || typeof state !== "object" || !("readingDetour" in state)) return null;
  const detour = state.readingDetour;
  if (!detour || typeof detour !== "object" || !("bookId" in detour) || detour.bookId !== bookId || !("returnTo" in detour)) return null;
  const returnTo = placeIn({ place: detour.returnTo });
  if (!returnTo) return null;
  const returning = "returning" in detour && detour.returning === true;
  const from = returning && "from" in detour ? placeIn({ place: detour.from }) : null;
  return { bookId, returnTo, ...(returning ? { returning: true } : {}), ...(from ? { from } : {}) };
}

/** Resolves the logical text anchor against the current viewport, in either reading layout. */
function restorePlace(place: Place): HTMLElement | null {
  const element = document.querySelector<HTMLElement>(`[data-block="${CSS.escape(place.blockId)}"]`);
  if (!element || element.closest<HTMLElement>("[data-chapter]")?.dataset.chapter !== place.chapterId) return null;
  window.scrollBy({ top: lineTop(element, place.offset) - eyeLine(), behavior: "instant" });
  return element;
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
  const historyState = useHistoryState();
  const detour = detourIn(historyState, bookId);
  const detourKey = JSON.stringify(detour);
  const [detourError, setDetourError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position>({ chapterId: null, percent: 0, minutesLeft: null, completed: false });
  // The newest progress saved from this page; the copy in `book` is only as fresh as the page load.
  const saved = useRef<Place | null>(null);
  const opened = useRef<Chapter | null>(null);
  const inUrl = useRef(chapterId);
  const restored = useRef<{ place: Place; scrollY: number } | null>(null);

  const finishReturn = useCallback((target: Place): boolean => {
    const element = restorePlace(target);
    if (!element) return false;
    saved.current = target;
    restored.current = { place: target, scrollY: window.scrollY };
    const { readingDetour: _detour, ...state } = history.state ?? {};
    changingHistory(() => history.replaceState({ ...state, place: target }, ""));
    element.focus({ preventScroll: true });
    setDetourError(null);
    return true;
  }, []);

  const visitPlace = useCallback((target: Place): boolean => {
    const place = placeIn({ place: target });
    const returnTo = detourIn(history.state, bookId)?.returnTo ?? placeAtEyeLine();
    if (!place || !book?.chapters.some((chapter) => chapter.id === place.chapterId) || !returnTo) {
      setDetourError("The passage is not available yet. Keep reading and try the search result again.");
      return false;
    }
    setDetourError(null);
    restored.current = null;
    const state = { ...history.state, place, readingDetour: { bookId, returnTo } };
    navigate(`/book/${bookId}/${place.chapterId}`, { state });
    const element = restorePlace(place);
    if (element) {
      restored.current = { place, scrollY: window.scrollY };
      element.focus({ preventScroll: true });
    }
    return true;
  }, [bookId, book, navigate]);

  const returnToPlace = useCallback(() => {
    const active = detourIn(history.state, bookId);
    if (!active) return;
    setDetourError(null);
    const from = active.from ?? placeAtEyeLine() ?? placeIn(history.state);
    const state = { ...history.state, place: active.returnTo, readingDetour: { ...active, returning: true, ...(from ? { from } : {}) } };
    changingHistory(() => navigate(`/book/${bookId}/${active.returnTo.chapterId}`, { replace: true, state }));
    if (finishReturn(active.returnTo)) return;
    if (start?.id === active.returnTo.chapterId || !book?.chapters.some((chapter) => chapter.id === active.returnTo.chapterId)) {
      setDetourError("The saved passage could not be found. Retry Return or keep reading here.");
    }
  }, [bookId, book, start, navigate, finishReturn]);

  const cancelReturn = useCallback(() => {
    const active = detourIn(history.state, bookId);
    if (!active?.returning || !active.from) return;
    setDetourError(null);
    const state = { ...history.state, place: active.from, readingDetour: { bookId, returnTo: active.returnTo } };
    changingHistory(() => navigate(`/book/${bookId}/${active.from!.chapterId}`, { replace: true, state }));
  }, [bookId, navigate]);

  const stayHere = useCallback(() => {
    if (!detourIn(history.state, bookId)) return;
    const spot = spotAtEyeLine();
    const last = spot?.blocks[spot.blocks.length - 1];
    const chapterId = spot?.chapter.dataset.chapter;
    const place = placeOf(spot) ?? (last?.dataset.block && chapterId ? { chapterId, blockId: last.dataset.block, offset: last.textContent?.length ?? 0 } : null);
    if (!place) {
      setDetourError("No chapter text is available yet. Retry when the chapter loads or return to the source.");
      return;
    }
    const { readingDetour: _detour, ...state } = history.state ?? {};
    changingHistory(() => history.replaceState({ ...state, place }, ""));
    restored.current = null;
    saved.current = place;
    setDetourError(null);
    void api.saveProgress(bookId, place.chapterId, place.blockId, place.offset).catch(() => {});
  }, [bookId]);

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
    if (detour?.returning) {
      if (finishReturn(detour.returnTo)) { opened.current = start ?? null; return; }
      if (start?.id === detour.returnTo.chapterId || (book && !book.chapters.some((chapter) => chapter.id === detour.returnTo.chapterId))) {
        setDetourError("The saved passage could not be found. Retry Return or keep reading here.");
      }
      return;
    }
    if (!book || !start || (opened.current === start && !detour)) return;
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
  }, [book, start, detourKey, finishReturn]);

  useEffect(() => {
    if (!book || !start) {
      // While a chapter opens, the top bar already names it and where it starts in the book.
      const id = book && inUrl.current;
      const opening: Position = id
        ? { chapterId: id, percent: bookPercent(book.chapters, id, 0), minutesLeft: null, completed: false }
        : { chapterId: null, percent: 0, minutesLeft: null, completed: false };
      setPosition((prev) => (same(prev, opening) ? prev : opening));
      return;
    }
    let measuring: number | undefined;
    let keeping: number | undefined;
    let saving: number | undefined;
    // The place at the last measurement: once the page is leaving, its text is gone and the eye line cannot be read.
    let latest: Place | null = null;
    // A cleanup from the source visit must remain quiet even when Return/Stay Here has just cleared its marker.
    const visiting = detourIn(history.state, bookId) !== null;
    const protectedPlace = () => restored.current?.scrollY === window.scrollY ? restored.current.place : null;

    const measure = () => {
      measuring = undefined;
      const spot = spotAtEyeLine();
      const id = spot?.chapter.dataset.chapter;
      if (!spot || !id) return;
      const fraction = fractionRead(spot);
      latest = placeOf(spot);
      const completed = atBookEnd();
      const next: Position = {
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
      if (detourIn(history.state, bookId)?.returning) return;
      const place = protectedPlace() ?? placeAtEyeLine();
      if (place) changingHistory(() => history.replaceState({ ...history.state, place }, ""));
    };

    const save = (leaving = false) => {
      if (visiting || detourIn(history.state, bookId)) return;
      // A page that is going away is read from the last measurement; one that is only hidden still has its text.
      const place = protectedPlace() ?? (leaving ? latest : (placeAtEyeLine() ?? latest));
      if (!place || (saved.current?.blockId === place.blockId && saved.current.offset === place.offset)) return;
      saved.current = place;
      api.saveProgress(bookId, place.chapterId, place.blockId, place.offset).catch(() => {
        // Progress is a convenience; reading must not be interrupted if saving fails.
      });
    };

    const onScroll = () => {
      if (restored.current && restored.current.scrollY !== window.scrollY) restored.current = null;
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
    // A reader who scrolls and leaves within the delay above must still be found where they stopped. Switching
    // away on a phone is how a tab ends, and it gives no other warning.
    const hidden = () => document.visibilityState === "hidden" && save();
    const leave = () => save();
    const resized = () => {
      const anchor = restored.current;
      if (anchor && restorePlace(anchor.place)) anchor.scrollY = window.scrollY;
      measure();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", resized);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", resized);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      save(true);
      window.clearTimeout(measuring);
      window.clearTimeout(keeping);
      window.clearTimeout(saving);
    };
  }, [book, start, bookId, navigate, detourKey]);

  return { ...position, detour, returning: detour?.returning === true && detourError === null, detourError, visitPlace, returnToPlace, cancelReturn, stayHere };
}
