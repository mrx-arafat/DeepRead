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
  /** The chapter's paragraphs and headings in the reader's language, by block id. */
  | { status: "ready"; blocks: Record<string, string> }
  | { status: "failed"; message: string; retry: () => void }
  /** The admin has turned translation off for readers. Said where it was asked for, after the switch has gone off. */
  | { status: "refused" };

// Translations already fetched on this page, by book, chapter and language. A chapter is translated once on the server
// and the answer never changes. Keep only recent chapters so opening many books cannot fill a phone's memory.
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
  // Retaining an answer avoids another fetch; publishing it must still pass through anchor-preserving commits.
  const retained = useRef<{ key: string; blocks: Record<string, string> } | null>(null);
  const activation = useRef<{ key: string } | null>(null);
  const [published, setPublished] = useState<{ key: string; blocks: Record<string, string>; activation: { key: string } } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const refuse = useEffectEvent(onRefused);
  const blocks = published?.key === key && published.activation === activation.current ? published.blocks : undefined;

  useEffect(() => {
    if (on && blocks) translationApplied(key);
  }, [on, key, blocks]);

  // Each time translation is turned on it starts afresh: off forgets a failure, and on forgets a refusal.
  if (!on && failure) setFailure(null);
  if (on && refused !== null) setRefused(null);

  useEffect(() => {
    if (!on) { activation.current = null; setPublished(null); return; }
    const active = { key };
    activation.current = active;
    const controller = new AbortController();
    let cancelCommit: (() => void) | undefined;
    const publish = (answer: Record<string, string>) => {
      cancelCommit = queueTranslationCommit(chapterId, () => {
        if (controller.signal.aborted) return;
        fetched.set(key, answer);
        retained.current = { key, blocks: answer };
        setPublished({ key, blocks: answer, activation: active });
      });
    };
    const cached = retained.current?.key === key ? retained.current.blocks : fetched.get(key);
    if (cached) {
      publish(cached);
      return () => { controller.abort(); cancelCommit?.(); };
    }
    queueTranslationRequest(key, JSON.stringify([bookId, lang]), controller.signal, () => api.chapterTranslation(bookId, chapterId, lang, controller.signal).then(
      (translation) => {
        if (controller.signal.aborted) return;
        publish(translation.blocks);
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
    return () => { controller.abort(); cancelCommit?.(); };
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
