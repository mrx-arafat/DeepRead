import { tierParams } from "../deviceTier.ts";

type Priority = { context: string; now: boolean; applied: boolean };
const priorities = new Map<string, Priority>();
type Request = { key: string; context: string; signal: AbortSignal; start: () => Promise<unknown> };
const requests: Request[] = [];
let inFlight = 0;
let pending = false;
let cancelIdle: (() => void) | undefined;

function pumpSoon(): void {
  if (pending) return;
  pending = true;
  queueMicrotask(() => { pending = false; pump(); });
}

function pump(atIdle = false): void {
  cancelIdle?.();
  cancelIdle = undefined;
  const params = tierParams();
  while (inFlight < params.translationInFlight) {
    const urgent = requests.findIndex((request) => priorities.get(request.key)?.now);
    const index = urgent >= 0 ? urgent : requests.findIndex((request) => {
      if (!params.translationAtIdle) return true;
      const eye = [...priorities.values()].find((priority) => priority.context === request.context && priority.now);
      return !eye || eye.applied;
    });
    if (index < 0) return;
    if (urgent < 0 && params.translationAtIdle && !atIdle) {
      if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(() => { cancelIdle = undefined; pump(true); }, { timeout: 2000 });
        cancelIdle = () => cancelIdleCallback(id);
      } else {
        const id = setTimeout(() => { cancelIdle = undefined; pump(true); }, 0);
        cancelIdle = () => clearTimeout(id);
      }
      return;
    }
    const request = requests.splice(index, 1)[0]!;
    if (request.signal.aborted) continue;
    inFlight++;
    const finished = () => { inFlight--; pumpSoon(); };
    void request.start().then(finished, finished);
  }
}

/** Register the eligibility hook's eye-line signal without changing chapter component props. */
export function registerTranslationPriority(key: string, context: string, now: boolean): () => void {
  const priority = { context, now, applied: false };
  priorities.set(key, priority);
  pumpSoon();
  return () => {
    if (priorities.get(key) === priority) priorities.delete(key);
    pumpSoon();
  };
}

/** Release neighbour prefetch after React has committed the eye-line translation. */
export function translationApplied(key: string): void {
  const priority = priorities.get(key);
  if (priority) priority.applied = true;
  pumpSoon();
}

/** Move request priority with the eye line while retaining its applied state. */
export function setTranslationPriority(key: string, now: boolean): void {
  const priority = priorities.get(key);
  if (priority) priority.now = now;
  pumpSoon();
}

/** Queue a cancellable chapter request; desktop keeps its immediate, unlimited path. */
export function queueTranslationRequest(key: string, context: string, signal: AbortSignal, start: () => Promise<unknown>): void {
  const request = { key, context, signal, start };
  requests.push(request);
  const remove = () => {
    const index = requests.indexOf(request);
    if (index >= 0) requests.splice(index, 1);
    pumpSoon();
  };
  signal.addEventListener("abort", remove, { once: true });
  if (tierParams().translationInFlight === Infinity) pump();
  else pumpSoon();
}

/** Recent chapter translations; mounted chapters keep their own answer independently of this cache. */
export class TranslationCache {
  private entries = new Map<string, { blocks: Record<string, string>; characters: number }>();
  private characters = 0;
  private readonly maxEntries: number | undefined;
  private readonly maxCharacters: number | undefined;

  constructor(maxEntries?: number, maxCharacters?: number) {
    this.maxEntries = maxEntries;
    this.maxCharacters = maxCharacters;
  }

  has(key: string): boolean { this.trim(); return this.entries.has(key); }

  get(key: string): Record<string, string> | undefined {
    this.trim();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.blocks;
  }

  set(key: string, blocks: Record<string, string>): void {
    const params = tierParams();
    const maxEntries = this.maxEntries ?? params.translationCacheEntries;
    const maxCharacters = this.maxCharacters ?? params.translationCacheChars;
    const old = this.entries.get(key);
    if (old) { this.entries.delete(key); this.characters -= old.characters; }
    const characters = Object.values(blocks).reduce((sum, text) => sum + text.length, 0);
    if (characters <= maxCharacters && maxEntries > 0) {
      this.entries.set(key, { blocks, characters });
      this.characters += characters;
    }
    this.trim();
  }

  private trim(): void {
    const params = tierParams();
    const maxEntries = this.maxEntries ?? params.translationCacheEntries;
    const maxCharacters = this.maxCharacters ?? params.translationCacheChars;
    while (this.entries.size > maxEntries || this.characters > maxCharacters) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.characters -= this.entries.get(oldest)!.characters;
      this.entries.delete(oldest);
    }
  }
}
