import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { LangCode } from "../../shared/types.ts";
import { api, ApiFailure } from "../api.ts";
import { indexAtLine } from "./book.ts";
import { eyeLine } from "./useReadingPosition.ts";
import { TranslationCache, queueTranslationRequest, translationApplied } from "./translationCache.ts";

export type ChapterTranslationState =
  | { status: "off" }
  | { status: "loading" }
  /**
   * The chapter's paragraphs and headings in the reader's language, by block id. `translating` while an AI helper is still
   * making the rest: the paragraphs here are the ones done so far, and more arrive. `stalled` when asking for the rest
   * failed: the paragraphs here stay, nothing more is asked for until the reader retries.
   */
  | { status: "ready"; blocks: Record<string, string>; translating?: true; stalled?: { message: string; retry: () => void } }
  | { status: "failed"; message: string; retry: () => void }
  /** The admin has turned translation off for readers. Said where it was asked for, after the switch has gone off. */
  | { status: "refused" };

// How long after a part of a chapter arrived the rest is asked for, while an AI helper is still making it.
const PARTS_EVERY_MS = 3_000;

// Translations already fetched on this page, by book, chapter and language. A whole chapter does not change on the server
// until a reader with an AI helper has it made again, which a page already showing it need not wait for. Keep only recent
// chapters so opening many books cannot fill a phone's memory.
const fetched = new TranslationCache();

// What the reader may be looking at, top to bottom: each box of a chapter (its title, a preview, the text's rows, the
// recap after it) and the lines between chapters. Never a box that holds others, a status line that comes and goes, or
// the tip, which floats beside the text on a wide screen and so is not in line with the rest.
const CHAPTER_SPOTS = ":scope > :not(.chapter-text, .translation-status, .tip), :scope > .chapter-text .row";

function spotAtEyeLine(): HTMLElement | undefined {
  const line = eyeLine();
  // Start with the few top-level sections, then inspect rows only in the chapter at the reader's eye line.
  const sections = document.querySelectorAll<HTMLElement>("main.page > *");
  const section = sections[indexAtLine(sections.length, (index) => sections[index]!.getBoundingClientRect().bottom, line)];
  if (!section?.dataset.chapter) return section;
  const spots = section.querySelectorAll<HTMLElement>(CHAPTER_SPOTS);
  return spots[indexAtLine(spots.length, (index) => spots[index]!.getBoundingClientRect().bottom, line)] ?? section;
}

function keepingSpot(spot: HTMLElement | undefined, change: () => void): void {
  const before = spot?.getBoundingClientRect().top;
  const root = document.documentElement;
  root.style.overflowAnchor = "none";
  flushSync(change);
  if (spot?.isConnected && before !== undefined) window.scrollBy({ top: spot.getBoundingClientRect().top - before, behavior: "instant" });
  requestAnimationFrame(() => root.style.removeProperty("overflow-anchor"));
}

/**
 * Runs `change`, which adds or removes translations or a chapter's status line, and scrolls by whatever that moved the
 * box at the eye line, so the paragraph the reader is on stays where it was on screen. Synchronous, so the reader never
 * sees a jump. The browser's own scroll anchoring is off meanwhile: not every browser has it, and where it acts it would
 * move the text a second time.
 */
export function keepingPlace(change: () => void): void {
  keepingSpot(spotAtEyeLine(), change);
}

type Commit = { chapterId: string; change: () => void; global: boolean; active: boolean };
let commits: Commit[] = [];
let scheduled = false;
let commitFrame: number | undefined;

/** A chapter arriving below the anchor, or below its own header, cannot move that anchor. */
function affectsSpot(commit: Commit, spot: HTMLElement): boolean {
  if (commit.global) return true;
  const chapter = document.querySelector<HTMLElement>(`[data-chapter="${CSS.escape(commit.chapterId)}"]`);
  if (!chapter) return false;
  if (spot.closest("[data-chapter]") === chapter && spot.matches(".chapter-head")) return false;
  return chapter.getBoundingClientRect().top < spot.getBoundingClientRect().bottom;
}

/** Coalesce arrivals into one layout correction, and let changes below the reader yield to interaction. */
export function queueTranslationCommit(chapterId: string, change: () => void, global = false): () => void {
  const commit: Commit = { chapterId, change, global, active: true };
  commits.push(commit);
  if (!scheduled) {
    scheduled = true;
    commitFrame = requestAnimationFrame(() => {
      scheduled = false;
      const batch = commits.filter((item) => item.active);
      commits = [];
      if (!batch.length) return;
      const spot = spotAtEyeLine();
      const apply = () => { for (const item of batch) if (item.active) item.change(); };
      if (spot && batch.some((item) => affectsSpot(item, spot))) keepingSpot(spot, apply);
      else startTransition(apply);
    });
  }
  return () => {
    commit.active = false;
    commits = commits.filter((item) => item.active);
    if (scheduled && !commits.length) {
      if (commitFrame !== undefined) cancelAnimationFrame(commitFrame);
      scheduled = false;
    }
  };
}

/**
 * One chapter in the reader's language while `on`: asked for the first time it is shown, all paragraphs at once, and
 * kept for the rest of the page's life. When an AI helper makes it, the server answers with the first paragraphs done and
 * the rest follow: they are asked for again every few seconds until the chapter is whole, and only a whole chapter is kept.
 * Nothing is asked while off, and turning it off cancels a request still out.
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
  // Retaining an answer avoids another fetch; publishing it must still pass through anchor-preserving commits.
  const retained = useRef<{ key: string; blocks: Record<string, string> } | null>(null);
  const activation = useRef<{ key: string } | null>(null);
  const [published, setPublished] = useState<{ key: string; blocks: Record<string, string>; activation: { key: string }; complete: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const refuse = useEffectEvent(onRefused);
  const blocks = published?.key === key && published.activation === activation.current ? published.blocks : undefined;

  // Neighbouring chapters are let go only once this one is whole: on a phone that asks for one chapter at a time, the single
  // place would otherwise go to a neighbour while the rest of this one waits behind it.
  const whole = published?.complete !== false;
  useEffect(() => {
    if (on && blocks && whole) translationApplied(key);
  }, [on, key, blocks, whole]);

  // Each time translation is turned on it starts afresh: off forgets a failure, and on forgets a refusal.
  if (!on && failure) setFailure(null);
  if (on && refused !== null) setRefused(null);

  useEffect(() => {
    if (!on) { activation.current = null; setPublished(null); return; }
    const active = { key };
    activation.current = active;
    const controller = new AbortController();
    let cancelCommit: (() => void) | undefined;
    const publish = (answer: Record<string, string>, complete: boolean) => {
      cancelCommit = queueTranslationCommit(chapterId, () => {
        if (controller.signal.aborted) return;
        // A part of a chapter is not kept: the next visit asks again, and gets the whole.
        if (complete) {
          fetched.set(key, answer);
          retained.current = { key, blocks: answer };
        }
        setPublished({ key, blocks: answer, activation: active, complete });
      });
    };
    const cached = retained.current?.key === key ? retained.current.blocks : fetched.get(key);
    if (cached) {
      publish(cached, true);
      return () => { controller.abort(); cancelCommit?.(); };
    }
    let nextPart: ReturnType<typeof setTimeout> | undefined;
    let shown = -1;
    const ask = () => queueTranslationRequest(key, JSON.stringify([bookId, lang]), controller.signal, () => api.chapterTranslation(bookId, chapterId, lang, controller.signal).then(
      (translation) => {
        if (controller.signal.aborted) return;
        const complete = translation.complete !== false;
        // Asking again before the helper has finished another batch gets the same paragraphs: nothing to show.
        const count = Object.keys(translation.blocks).length;
        if (complete || count !== shown) publish(translation.blocks, complete);
        shown = count;
        if (!complete) nextPart = setTimeout(ask, PARTS_EVERY_MS);
      },
      (error: Error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiFailure && error.status === 403 && error.code === "translation_off") {
          cancelCommit = queueTranslationCommit(chapterId, () => {
            if (controller.signal.aborted) return;
            setRefused(key);
            refuse();
          }, true);
          return;
        }
        cancelCommit = queueTranslationCommit(chapterId, () => {
          if (!controller.signal.aborted) setFailure({ key, message: error.message });
        });
      },
    ));
    ask();
    return () => { controller.abort(); cancelCommit?.(); clearTimeout(nextPart); };
  }, [on, key, attempt, bookId, chapterId, lang]);

  if (!on) return refused === key ? { status: "refused" } : { status: "off" };
  if (failure?.key === key) {
    const retry = () =>
      keepingPlace(() => {
        setFailure(null);
        setAttempt((count) => count + 1);
      });
    // Asking for the rest of a chapter can fail after its first paragraphs have arrived: what the reader has stays.
    if (blocks) return { status: "ready", blocks, stalled: { message: failure.message, retry } };
    return { status: "failed", message: failure.message, retry };
  }
  if (blocks) return { status: "ready", blocks, ...(published?.complete === false && { translating: true as const }) };
  return { status: "loading" };
}
