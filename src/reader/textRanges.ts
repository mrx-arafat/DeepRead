// Finding words and sentences inside a block of book text.
// Every block renders as one text node, so offsets here are offsets into `block.text`.

import type { Block } from "../../shared/types.ts";

export type Span = { start: number; end: number };

export type Sentence = Span & { blockId: string; text: string };

/** Where a sentence sits in the book. Unlike a list index, it stays true when more chapters are added. */
export type SentenceAt = { blockId: string; start: number };

const words = new Intl.Segmenter("en", { granularity: "word" });
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** The word touching `offset`, or null when the offset sits in spaces or punctuation. */
export function wordAt(text: string, offset: number): Span | null {
  for (const part of words.segment(text)) {
    const end = part.index + part.segment.length;
    if (part.isWordLike && offset >= part.index && offset <= end) {
      return { start: part.index, end };
    }
    if (part.index > offset) break;
  }
  return null;
}

/** Sentences of `text` with surrounding whitespace trimmed off. */
export function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const part of sentences.segment(text)) {
    const trimmed = part.segment.trim();
    if (!trimmed) continue;
    const start = part.index + part.segment.indexOf(trimmed);
    spans.push({ start, end: start + trimmed.length });
  }
  return spans;
}

// Blocks never change once loaded, so each is split once, not again every time a chapter is appended.
const splitBlocks = new WeakMap<Block, Sentence[]>();

/** Every sentence of `blocks`, in reading order. */
export function sentencesOf(blocks: Block[]): Sentence[] {
  return blocks.flatMap((block) => {
    let list = splitBlocks.get(block);
    if (!list) {
      list = sentenceSpans(block.text).map((span) => ({
        ...span,
        blockId: block.id,
        text: block.text.slice(span.start, span.end),
      }));
      splitBlocks.set(block, list);
    }
    return list;
  });
}

/** Index of the sentence at `at`, or -1 when it is not in the list. */
export function sentenceIndex(sentences: Sentence[], at: SentenceAt): number {
  return sentences.findIndex((sentence) => sentence.blockId === at.blockId && sentence.start === at.start);
}

/** The book block element that contains `node`, if any. */
export function blockOf(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>("[data-block]") ?? null;
}

function caretAt(x: number, y: number): { node: Text; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const caret = doc.caretPositionFromPoint(x, y);
    return caret?.offsetNode instanceof Text ? { node: caret.offsetNode, offset: caret.offset } : null;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range?.startContainer instanceof Text
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}

/** A range around the word under the pointer, or null if the pointer is not on a word. */
export function wordRangeAtPoint(x: number, y: number): Range | null {
  const caret = caretAt(x, y);
  if (!caret || !blockOf(caret.node)) return null;
  const span = wordAt(caret.node.data, caret.offset);
  if (!span) return null;
  const range = document.createRange();
  range.setStart(caret.node, span.start);
  range.setEnd(caret.node, span.end);
  // The caret snaps to the nearest text even from empty space, so confirm the pointer hit the word.
  const slack = 3;
  const hit = [...range.getClientRects()].some(
    (rect) =>
      x >= rect.left - slack && x <= rect.right + slack && y >= rect.top - slack && y <= rect.bottom + slack,
  );
  return hit ? range : null;
}

/** A range over part of a rendered block, or null if that block is not on the page. */
export function rangeInBlock(blockId: string, span: Span): Range | null {
  const node = document.querySelector(`[data-block="${CSS.escape(blockId)}"]`)?.firstChild;
  if (!(node instanceof Text) || span.end > node.length) return null;
  const range = document.createRange();
  range.setStart(node, span.start);
  range.setEnd(node, span.end);
  return range;
}

/** Paint (or clear) a named highlight without touching the DOM. Styled via `::highlight(name)`. */
export function setHighlight(name: string, range: Range | null) {
  if (!("highlights" in CSS)) return;
  if (range) CSS.highlights.set(name, new Highlight(range));
  else CSS.highlights.delete(name);
}
