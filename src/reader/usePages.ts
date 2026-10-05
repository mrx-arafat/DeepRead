import { useCallback, useEffect, useRef, useState } from "react";
import {
  chapterStarts,
  linesIn,
  pageEnd,
  pageFrame,
  pagesLeft,
  previousPageTop,
  setShownEnd,
  snapShift,
  type Box,
} from "./paging.ts";

export type Pages = {
  /** Where the strip over the bottom of the page starts, in px from the window top; null while scrolling. */
  end: number | null;
  /** Whole pages left in the chapter after this one; null until measured. */
  left: number | null;
  /** The top bar has slid away while the reader reads. */
  barAway: boolean;
};

/** One flick of a wheel or a trackpad turns one page: the events of one gesture come closer together than this. */
const GESTURE_GAP_MS = 220;
/** How far the wheel must go, in px, before it counts as a turn and not a nudge. */
const WHEEL_TURN = 30;
/** How far a finger must travel, in px, for a swipe; less is a tap or a wobble. */
const SWIPE = 50;
/** How long the top bar stays when a book opens in pages, so the reader sees where it went. */
const BAR_INTRO_MS = 2500;

// Everything a reader acts on: a press there is never a page turn.
const CONTROLS =
  "a, button, input, select, textarea, label, summary, [contenteditable], [data-block], .note, .tip, .aid, .topbar, .listen-bar, .toast, dialog, [popover], .book-end";

// Where a wheel or a swipe belongs to the control under it, not to the page: a slider, the menus, the player.
const OWN_GESTURES = "input, select, textarea, dialog, [popover], .topbar, .listen-bar";

/** The Aa menu or the chapter list is open, or `target` is a control that takes the gesture itself. */
function gestureTaken(target: EventTarget | null): boolean {
  if (document.querySelector(":popover-open, dialog[open]")) return true;
  return target instanceof Element && target.closest(OWN_GESTURES) !== null;
}

/** An element under `target` that scrolls on its own (the chapter list, the Aa menu, a long note) keeps its wheel. */
function scrollsItself(target: EventTarget | null): boolean {
  for (let element = target instanceof Element ? target : null; element && element !== document.body; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if ((overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight) return true;
  }
  return false;
}

const toDocument = (lines: Box[]) => lines.map((line) => ({ top: line.top + window.scrollY, bottom: line.bottom + window.scrollY }));

/**
 * Pages over the book's one scroll: a turn moves the window so the first line not shown whole starts the next page,
 * and a strip hides any line cut by the bottom edge. Keys, the wheel, a swipe and a press beside the column turn
 * pages; nothing scrolls freely. `paused` while a word card or the Explain bar is open, which a turn would leave behind.
 */
export function usePages(on: boolean, ready: boolean, paused: boolean): Pages {
  const [end, setEnd] = useState<number | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [barAway, setBarAway] = useState(false);
  // The page before ends where the one the reader turned back from began, not wherever the lines would let it.
  const until = useRef<{ scroll: number; end: number } | null>(null);
  // Where the page shown ends, as measured at that scroll position: the next page starts exactly there, even if the
  // window has changed height since (a phone's toolbars come and go).
  const shownAt = useRef<{ scroll: number; end: number } | null>(null);
  // Each forward turn, from where to where, so turning back shows those very pages again. Only while the window is
  // still where that turn left it: a reflow, a chapter loading above or a jump moves it, and the turns no longer hold.
  const turned = useRef<{ from: number; to: number }[]>([]);
  const pausedNow = useRef(paused);
  pausedNow.current = paused;

  const settle = useCallback(() => {
    const frame = pageFrame();
    const band = () => linesIn(frame.top - 120, frame.bottom + 240);
    let lines = band();
    const shift = snapShift(lines, frame.top);
    if (shift !== 0 && window.scrollY + shift >= 0) {
      window.scrollBy({ top: shift, behavior: "instant" });
      lines = band();
    }
    const starts = chapterStarts();
    let at = pageEnd(lines, frame.top, frame.bottom, starts);
    // Only the blank end of a chapter before the next one starts (as when the chapter before loads above the one
    // just opened): open the next chapter's first page instead.
    const blank = !lines.some((line) => line.top >= frame.top - 0.5 && line.bottom <= at + 0.5);
    if (blank && starts.includes(at)) {
      window.scrollBy({ top: at - frame.top, behavior: "instant" });
      return;
    }
    const kept = until.current;
    if (kept && Math.abs(kept.scroll - window.scrollY) < 1) at = Math.min(at, kept.end - window.scrollY);
    shownAt.current = { scroll: window.scrollY, end: at };
    setEnd(at);
    setShownEnd(at);
    // The chapter the page starts in, and how far its text runs on below this page.
    const chapters = [...document.querySelectorAll<HTMLElement>("[data-chapter]")];
    const chapter = chapters.findLast((item) => item.getBoundingClientRect().top <= frame.top + 1) ?? chapters[0];
    const bottom = chapter?.lastElementChild?.getBoundingClientRect().bottom;
    setLeft(bottom === undefined ? null : pagesLeft(bottom, at, frame.top, frame.bottom));
  }, []);

  const turn = useCallback((way: "next" | "previous", scroll: number) => {
    window.scrollTo({ top: scroll, behavior: "instant" });
    setBarAway(true);
    // A reader turning pages from the bar (after the Aa menu, say) is back to reading: the bar may go.
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest(".topbar")) document.activeElement.blur();
    const page = document.querySelector<HTMLElement>("main.page");
    if (!page) return;
    // Restarted on every turn, so quick turns each get their slide.
    page.classList.remove("turn-next", "turn-previous");
    void page.offsetWidth;
    page.classList.add(way === "next" ? "turn-next" : "turn-previous");
  }, []);

  const next = useCallback(() => {
    const frame = pageFrame();
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (window.scrollY >= max - 1) return;
    // Measured at this very scroll position, or else not to be trusted.
    const here = (measured: { scroll: number; end: number } | null) =>
      measured && Math.abs(measured.scroll - window.scrollY) < 1 ? measured.end : null;
    const turnedBackTo = here(until.current);
    until.current = null;
    const at =
      here(shownAt.current) ??
      (turnedBackTo === null ? null : turnedBackTo - window.scrollY) ??
      pageEnd(linesIn(frame.top - 120, frame.bottom + 240), frame.top, frame.bottom, chapterStarts());
    const from = window.scrollY;
    turn("next", Math.min(from + Math.max(at - frame.top, 1), max));
    turned.current.push({ from, to: window.scrollY });
  }, [turn]);

  const previous = useCallback(() => {
    if (window.scrollY <= 0) return;
    const frame = pageFrame();
    const height = frame.bottom - frame.top;
    const current = window.scrollY + frame.top;
    const back = turned.current.pop();
    if (back && Math.abs(back.to - window.scrollY) < 1) {
      turn("previous", back.from);
      until.current = { scroll: window.scrollY, end: current };
      return;
    }
    turned.current = [];
    const lines = toDocument(linesIn(frame.top - height - 120, frame.top + 4));
    const starts = chapterStarts().map((at) => at + window.scrollY);
    const scroll = Math.max(0, previousPageTop(lines, current, frame.top, frame.bottom, starts) - frame.top);
    turn("previous", scroll);
    until.current = { scroll: window.scrollY, end: current };
  }, [turn]);

  useEffect(() => {
    if (!on || !ready) {
      setEnd(null);
      setLeft(null);
      setShownEnd(null);
      shownAt.current = null;
      turned.current = [];
      setBarAway(false);
      return;
    }
    let frame: number | undefined;
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(() => {
        frame = undefined;
        settle();
      });
    };
    schedule();
    const intro = window.setTimeout(() => setBarAway(true), BAR_INTRO_MS);

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || pausedNow.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, select, textarea, [contenteditable], dialog, [popover]")) return;
      // Space presses a focused button or link; the arrows and Page keys do nothing there, so they still turn.
      if (event.key === " " && target?.closest("button, a, summary")) return;
      if (document.querySelector(":popover-open, dialog[open]")) return;
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown" || (event.key === " " && !event.shiftKey);
      const back = event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp" || (event.key === " " && event.shiftKey);
      if (!forward && !back) return;
      event.preventDefault();
      if (forward) next();
      else previous();
    };

    let wheelAt = 0;
    let wheelSum = 0;
    let wheelTurned = false;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || pausedNow.current || gestureTaken(event.target) || scrollsItself(event.target)) return;
      const now = performance.now();
      if (now - wheelAt > GESTURE_GAP_MS) {
        wheelSum = 0;
        wheelTurned = false;
      }
      wheelAt = now;
      wheelSum += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (wheelTurned || Math.abs(wheelSum) < WHEEL_TURN) return;
      wheelTurned = true;
      if (wheelSum > 0) next();
      else previous();
    };

    // Kept from the press: a press that closes a word card only closes it, by swipe or by click.
    let press: { x: number; y: number; id: number; touch: boolean; quiet: boolean } | null = null;
    let clickQuiet = false;
    const onPointerDown = (event: PointerEvent) => {
      clickQuiet = pausedNow.current;
      press = {
        x: event.clientX,
        y: event.clientY,
        id: event.pointerId,
        touch: event.pointerType !== "mouse",
        quiet: pausedNow.current || gestureTaken(event.target) || scrollsItself(event.target),
      };
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = press;
      press = null;
      if (!start?.touch || start.quiet || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE || window.getSelection()?.isCollapsed === false) return;
      // Left or up turns on, as a page is pushed aside; right or down turns back.
      if ((Math.abs(dx) > Math.abs(dy) ? dx : dy) < 0) next();
      else previous();
    };
    const onClick = (event: MouseEvent) => {
      if (clickQuiet || event.button !== 0 || !(event.target instanceof Element) || event.target.closest(CONTROLS)) return;
      if (window.getSelection()?.isCollapsed === false) return;
      const frameNow = pageFrame();
      // The top margin is where the bar hides: a press there brings it back, or sends it away again.
      if (event.clientY < frameNow.top) {
        setBarAway((away) => !away);
        return;
      }
      const column = document.querySelector("main.page .chapter")?.getBoundingClientRect();
      if (!column) return;
      if (event.clientX < column.left) previous();
      else if (event.clientX > column.right) next();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (event.clientY < 64) setBarAway(false);
      else if (event.clientY > 160) setBarAway(true);
    };

    const page = document.querySelector("main.page");
    const resized = new ResizeObserver(schedule);
    if (page) resized.observe(page);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("click", onClick);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.clearTimeout(intro);
      resized.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("click", onClick);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [on, ready, settle, next, previous]);

  return { end, left, barAway };
}
