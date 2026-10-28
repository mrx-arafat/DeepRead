// The text of a chapter in chunks of rows, and which chunks are on the page as rows rather than as placeholders.
// Pure: the DOM side (observers, measuring, scroll corrections) is useChunkWindow.ts, so this is tested without a browser.
import type { Block } from "../../shared/types.ts";

/** A few dozen rows that mount and unmount together; `key` is the first block's id and never changes for a chapter. */
export type Chunk = { key: string; blocks: Block[]; /** Index of the first block among the chapter's blocks. */ start: number };

/** Rows grouped `rowsPerChunk` at a time; a figure stands alone, so decoding an image never forces prose to render. */
export function chunksOf(blocks: readonly Block[], rowsPerChunk: number): Chunk[] {
  const chunks: Chunk[] = [];
  blocks.forEach((block, at) => {
    const previous = chunks.at(-1);
    if (block.type === "image" || !previous || previous.blocks[0]?.type === "image" || previous.blocks.length >= rowsPerChunk) {
      chunks.push({ key: block.id, blocks: [block], start: at });
    } else previous.blocks.push(block);
  });
  return chunks;
}

/** Which chunk holds each block. */
export function chunkKeys(chunks: readonly Chunk[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const chunk of chunks) for (const block of chunk.blocks) keys.set(block.id, chunk.key);
  return keys;
}

export type WindowState = {
  /** Chunks showing their rows now. */
  mounted: ReadonlySet<string>;
  /** Chunks inside the mount margin, as the observer last reported them. */
  near: ReadonlySet<string>;
  /** Chunks inside the wider keep margin: a mounted chunk stays until it leaves this too. */
  kept: ReadonlySet<string>;
  /** Chunks something is using (a card, the voice, the keyboard, a selection) and chunks with a note card. */
  pinned: ReadonlySet<string>;
  /** Chunks the keep observer has reported at all: a mounted chunk it has not seen yet (it opened, or was mounted on request) counts as kept. */
  reported: ReadonlySet<string>;
};

/**
 * The chunks that should show their rows: near or pinned ones mount, and a mounted one stays while it is still kept, or
 * until the keep observer has reported it at all (so nothing is evicted before the observers have spoken).
 */
export function windowOf(chunks: readonly Chunk[], state: WindowState): Set<string> {
  const next = new Set<string>();
  for (const { key } of chunks) {
    const stays = state.mounted.has(key) && (state.kept.has(key) || !state.reported.has(key));
    if (state.near.has(key) || state.pinned.has(key) || stays) next.add(key);
  }
  return next;
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/** What opens mounted before the observers report: the chapter's first chunks, and the chunk around the saved place. */
export function initialMounted(chunks: readonly Chunk[], initialChunks: number, openAt?: string): Set<string> {
  const mounted = new Set<string>();
  for (const chunk of chunks.slice(0, Math.max(0, initialChunks))) mounted.add(chunk.key);
  if (openAt !== undefined) {
    const at = chunks.findIndex((chunk) => chunk.blocks.some((block) => block.id === openAt));
    for (const chunk of at === -1 ? [] : chunks.slice(Math.max(0, at - 1), at + 2)) mounted.add(chunk.key);
  }
  return mounted;
}

/** The chunks of a new chunking that hold the rows mounted in the old one, so a tier change keeps the rows around the reader. */
export function carriedMounted(previous: readonly Chunk[], mounted: ReadonlySet<string>, keyOf: ReadonlyMap<string, string>): Set<string> {
  const next = new Set<string>();
  for (const chunk of previous) {
    if (!mounted.has(chunk.key)) continue;
    for (const block of chunk.blocks) {
      const key = keyOf.get(block.id);
      if (key) next.add(key);
    }
  }
  return next;
}

/** A placeholder's height is guessed from its text: so many pixels a character, plus so many a block (its margins and the part of its last line left empty). */
export type Calibration = { pxPerChar: number; pxPerBlock: number };

/** Before anything is measured: a line holds about two characters per em, so a character costs that share of a line. */
export function defaultCalibration(fontSize: number, lineHeight: number, width: number): Calibration {
  const charsPerLine = Math.max(10, width / (fontSize * 0.5));
  return { pxPerChar: lineHeight / charsPerLine, pxPerBlock: lineHeight * 1.5 };
}

export type HeightSample = { chars: number; blocks: number; height: number };

/** The calibration the measured chunks imply, keeping the fallback's per-block cost; the fallback itself without samples. */
export function calibrate(samples: readonly HeightSample[], fallback: Calibration): Calibration {
  let chars = 0;
  let blocks = 0;
  let height = 0;
  for (const sample of samples) {
    chars += sample.chars;
    blocks += sample.blocks;
    height += sample.height;
  }
  if (chars < 200 || height <= 0) return fallback;
  const pxPerChar = (height - blocks * fallback.pxPerBlock) / chars;
  return { pxPerChar: Math.max(fallback.pxPerChar / 4, pxPerChar), pxPerBlock: fallback.pxPerBlock };
}

/** The text of the blocks that count as text: a figure has none. */
export const charsOf = (blocks: readonly Block[]): number => blocks.reduce((sum, block) => sum + (block.type === "image" ? 0 : block.text.length), 0);

/** How tall a chunk should be before it is measured; `width` is the column's, which a figure fills up to its own width. */
export function estimateHeight(blocks: readonly Block[], calibration: Calibration, width: number): number {
  let height = 0;
  for (const block of blocks) {
    if (block.type === "image") {
      const image = block.image;
      const sized = image && image.width > 0 && image.height > 0;
      // The figure's own margins (book-content.css) around its aspect ratio; an unsized legacy figure gets a middling guess.
      height += (sized ? (Math.min(width, image.width) * image.height) / image.width : 240) + 48;
    } else height += block.text.length * calibration.pxPerChar + calibration.pxPerBlock;
  }
  return Math.max(1, Math.round(height));
}

/** One signature for everything that changes measured heights: the typography, the column width, translations, the tier. */
export function epochOf(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

/** Measured chunk heights by chunk, each with the epoch it was measured in: a height from another epoch is not reused. */
export class ChunkHeights {
  private readonly entries = new Map<string, { epoch: string; height: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries = 4000) {
    this.maxEntries = maxEntries;
  }

  remember(key: string, epoch: string, height: number): void {
    if (!Number.isFinite(height) || height <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { epoch, height });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(key: string, epoch: string): number | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.epoch !== epoch) return undefined;
    // Touched: a chunk the reader keeps passing stays remembered.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.height;
  }

  get size(): number {
    return this.entries.size;
  }
}
