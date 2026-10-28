// Where the book's text is on the page, and how to bring a piece of it there. Chunks of text far from the reader are
// placeholders without their rows (useChunkWindow); anything that needs a block's element first asks for it here.
// Three primitives keep every feature safe: `ensureMounted` mounts a block's chunk at once, `pin` keeps the chunks a
// feature is using from unmounting, and `useMountVersion` re-runs work that painted on the DOM once a chunk comes or goes.
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export type BlockPlace = { chapterId: string; blockId: string };

/** Mounts the chunk holding a block; false when the chapter has no such block. */
type MountBlock = (blockId: string) => boolean;

const windows = new Map<string, MountBlock>();
const pins = new Map<string, BlockPlace[]>();
const mountListeners = new Set<() => void>();
const pinListeners = new Set<() => void>();
let version = 0;

/** A chapter's text registers how to mount the chunk holding one of its blocks; returns the way to unregister. */
export function registerWindow(chapterId: string, mountBlock: MountBlock): () => void {
  windows.set(chapterId, mountBlock);
  return () => {
    if (windows.get(chapterId) === mountBlock) windows.delete(chapterId);
  };
}

/** A block's element (or a chapter title's, which is read like a block), or null when it is not on the page. */
export function blockElement(blockId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const byId = document.getElementById(blockId);
  if (byId) return byId;
  // Before every block carries its id as an attribute, the way the reader always found them.
  return document.querySelector<HTMLElement>(`[data-block="${CSS.escape(blockId)}"]`);
}

/**
 * The block's element, mounting its chunk first when it is a placeholder. Synchronous, so a caller can scroll to it or
 * focus it in the same breath. Null when the chapter is not on the page or has no such block.
 */
export function ensureMounted(chapterId: string, blockId: string): HTMLElement | null {
  const mount = windows.get(chapterId);
  if (mount) flushSync(() => void mount(blockId));
  return blockElement(blockId);
}

/** Keeps the chunks holding `places` mounted for `owner` (the player, a word card, a source visit) until it pins others or none. */
export function pin(owner: string, places: BlockPlace[]): void {
  const before = pins.get(owner);
  if (places.length === 0) {
    if (!before) return;
    pins.delete(owner);
  } else {
    if (before && before.length === places.length && before.every((place, at) => place.chapterId === places[at]!.chapterId && place.blockId === places[at]!.blockId)) return;
    pins.set(owner, places.map((place) => ({ ...place })));
  }
  for (const listener of pinListeners) listener();
}

/** The blocks pinned in a chapter, by every owner together. */
export function pinnedBlocks(chapterId: string): ReadonlySet<string> {
  const blocks = new Set<string>();
  for (const places of pins.values()) for (const place of places) if (place.chapterId === chapterId) blocks.add(place.blockId);
  return blocks;
}

/** The chapters holding a pinned block: the flow never trims these. */
export function pinnedChapters(): ReadonlySet<string> {
  const chapters = new Set<string>();
  for (const places of pins.values()) for (const place of places) chapters.add(place.chapterId);
  return chapters;
}

/** Called when the pins change, so a window can mount a chunk that was just pinned. */
export function subscribePins(listener: () => void): () => void {
  pinListeners.add(listener);
  return () => void pinListeners.delete(listener);
}

/** A window calls this after a commit that mounted or unmounted chunks. */
export function bumpMounts(): void {
  version += 1;
  for (const listener of mountListeners) listener();
}

/** How many times chunks have come or gone; a dependency for work that painted ranges on the DOM. */
export function mountVersion(): number {
  return version;
}

function subscribeMounts(listener: () => void): () => void {
  mountListeners.add(listener);
  return () => void mountListeners.delete(listener);
}

/** `mountVersion`, re-rendering when it changes: note marks, highlights and the search mark repaint on it. */
export function useMountVersion(): number {
  return useSyncExternalStore(subscribeMounts, mountVersion, mountVersion);
}
