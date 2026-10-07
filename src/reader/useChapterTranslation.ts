import { useEffect, useEffectEvent, useState } from "react";
import { flushSync } from "react-dom";
import type { LangCode } from "../../shared/types.ts";
import { api, ApiFailure } from "../api.ts";
import { indexAtLine } from "./book.ts";
import { eyeLine } from "./useReadingPosition.ts";

export type ChapterTranslationState =
  | { status: "off" }
  | { status: "loading" }
  /** The chapter's paragraphs and headings in the reader's language, by block id. */
  | { status: "ready"; blocks: Record<string, string> }
  | { status: "failed"; message: string; retry: () => void }
  /** The admin has turned translation off for readers. Said where it was asked for, after the switch has gone off. */
  | { status: "refused" };

// Translations already fetched on this page, by book, chapter and language. A chapter is translated once on the server
// and the answer never changes, so turning translation off and on again, or coming back to a chapter, asks nothing.
const fetched = new Map<string, Record<string, string>>();

// What the reader may be looking at, top to bottom: each box of a chapter (its title, a preview, the text's rows, the
// recap after it) and the lines between chapters. Never a box that holds others, a status line that comes and goes, or
// the tip, which floats beside the text on a wide screen and so is not in line with the rest.
const SPOTS = "main.page > :not([data-chapter]), [data-chapter] > :not(.chapter-text, .translation-status, .tip), .chapter-text > .row";

/**
 * Runs `change`, which adds or removes translations or a chapter's status line, and scrolls by whatever that moved the
 * box at the eye line, so the paragraph the reader is on stays where it was on screen. Synchronous, so the reader never
 * sees a jump. The browser's own scroll anchoring is off meanwhile: not every browser has it, and where it acts it would
 * move the text a second time.
 */
export function keepingPlace(change: () => void): void {
  const spots = document.querySelectorAll<HTMLElement>(SPOTS);
  const spot = spots[indexAtLine(spots.length, (index) => spots[index]!.getBoundingClientRect().bottom, eyeLine())];
  const before = spot?.getBoundingClientRect().top;
  const root = document.documentElement;
  root.style.overflowAnchor = "none";
  flushSync(change);
  if (spot?.isConnected && before !== undefined) window.scrollBy({ top: spot.getBoundingClientRect().top - before, behavior: "instant" });
  requestAnimationFrame(() => root.style.removeProperty("overflow-anchor"));
}

/**
 * One chapter in the reader's language while `on`: asked for the first time it is shown, all paragraphs at once, and
 * kept for the rest of the page's life. Nothing is asked while off, and turning it off cancels a request still out.
 * When the server says the admin turned translation off, `onRefused` hands the switch back.
 */
export function useChapterTranslation(
  bookId: string,
  chapterId: string,
  lang: LangCode,
  on: boolean,
  onRefused: () => void,
): ChapterTranslationState {
  const key = JSON.stringify([bookId, chapterId, lang]);
  const [, setArrived] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const refuse = useEffectEvent(onRefused);
  const blocks = fetched.get(key);

  // Each time translation is turned on it starts afresh: off forgets a failure, and on forgets a refusal.
  if (!on && failure) setFailure(null);
  if (on && refused !== null) setRefused(null);

  useEffect(() => {
    if (!on || fetched.has(key)) return;
    const controller = new AbortController();
    api.chapterTranslation(bookId, chapterId, lang, controller.signal).then(
      (translation) => {
        fetched.set(key, translation.blocks);
        keepingPlace(() => setArrived((count) => count + 1));
      },
      (error: Error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiFailure && error.status === 403 && error.code === "translation_off") {
          keepingPlace(() => {
            setRefused(key);
            refuse();
          });
          return;
        }
        keepingPlace(() => setFailure({ key, message: error.message }));
      },
    );
    return () => controller.abort();
  }, [on, key, attempt, bookId, chapterId, lang]);

  if (!on) return refused === key ? { status: "refused" } : { status: "off" };
  if (blocks) return { status: "ready", blocks };
  if (failure?.key === key) {
    const retry = () =>
      keepingPlace(() => {
        setFailure(null);
        setAttempt((count) => count + 1);
      });
    return { status: "failed", message: failure.message, retry };
  }
  return { status: "loading" };
}
