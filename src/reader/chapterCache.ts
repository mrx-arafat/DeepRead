// Chapters read on this page, kept after they leave it so coming back is instant and never shows "Opening the
// chapter...". Bounded by entries and characters from the device tier, the way the translation cache is, so a long
// session on a small phone cannot fill its memory with text the reader has moved on from. A chapter asked for while
// its request is already out joins that request: the flow's look-ahead and its mount never fetch the same text twice.
import type { Chapter } from "../../shared/types.ts";
import { api } from "../api.ts";
import { tierParams } from "../deviceTier.ts";

export type CacheBounds = { entries: number; characters: number };

/** The key a chapter is kept under: chapters of different books can share an id. */
export const chapterKey = (bookId: string, chapterId: string): string => `${bookId}:${chapterId}`;

/** Least recently read chapters go first; one over the whole budget is never kept. */
export class ChapterCache {
  private readonly entries = new Map<string, { chapter: Chapter; characters: number }>();
  private characters = 0;
  private readonly bounds: () => CacheBounds;

  /** `bounds` is read on every write, so a tier change while reading applies without a restart. */
  constructor(bounds: () => CacheBounds) {
    this.bounds = bounds;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The chapter, now the most recently read; undefined when it is not kept. */
  get(key: string): Chapter | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.chapter;
  }

  set(key: string, chapter: Chapter): void {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.characters -= old.characters;
    }
    const { entries, characters: budget } = this.bounds();
    const characters = chapter.blocks.reduce((sum, block) => sum + block.text.length, 0);
    if (characters > budget || entries <= 0) return;
    this.entries.set(key, { chapter, characters });
    this.characters += characters;
    while (this.entries.size > entries || this.characters > budget) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.characters -= this.entries.get(oldest)!.characters;
      this.entries.delete(oldest);
    }
  }
}

/** The one cache the reader page shares: the chapter flow, the in-book search and notebook source links all read through it. */
export const chapterCache = new ChapterCache(() => {
  const params = tierParams();
  return { entries: params.chapterCacheEntries, characters: params.chapterCacheChars };
});

/** A chapter kept on this page, at once, or undefined when it has to be asked for. */
export function cachedChapter(bookId: string, chapterId: string): Chapter | undefined {
  return chapterCache.get(chapterKey(bookId, chapterId));
}

// Requests out now, by chapter: a second reader of the same chapter waits on the first request rather than making
// its own, and the request is given up only when the last of them has.
const pending = new Map<string, { promise: Promise<Chapter>; controller: AbortController; waiting: number }>();

/** The chapter, from the cache or else from the server, kept for the next read. Rejects with the signal's reason when `signal` aborts. */
export function loadChapter(bookId: string, chapterId: string, signal?: AbortSignal): Promise<Chapter> {
  const key = chapterKey(bookId, chapterId);
  const kept = chapterCache.get(key);
  if (kept) return Promise.resolve(kept);
  let request = pending.get(key);
  if (!request) {
    const controller = new AbortController();
    const promise = api
      .getChapter(bookId, chapterId, controller.signal)
      .then((chapter) => {
        chapterCache.set(key, chapter);
        return chapter;
      })
      .finally(() => {
        if (pending.get(key)?.controller === controller) pending.delete(key);
      });
    request = { promise, controller, waiting: 0 };
    pending.set(key, request);
  }
  if (!signal) return request.promise;
  const shared = request;
  shared.waiting += 1;
  return new Promise((resolve, reject) => {
    const leave = () => {
      shared.waiting -= 1;
      if (shared.waiting === 0) {
        shared.controller.abort();
        if (pending.get(key) === shared) pending.delete(key);
      }
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The chapter was no longer needed.", "AbortError"));
    };
    if (signal.aborted) {
      leave();
      return;
    }
    signal.addEventListener("abort", leave, { once: true });
    shared.promise.then(
      (chapter) => {
        signal.removeEventListener("abort", leave);
        resolve(chapter);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", leave);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
