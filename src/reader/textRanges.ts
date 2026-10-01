// Finding words and sentences inside a block of book text.
// Every block renders as one text node, so offsets here are offsets into `block.text`.

import type { Block } from "../../shared/types.ts";

export type Span = { start: number; end: number };

export type Sentence = Span & { blockId: string; text: string };

/** Where a sentence sits in the book. Unlike a list index, it stays true when more chapters are added. */
export type SentenceAt = { blockId: string; start: number };

const words = new Intl.Segmenter("en", { granularity: "word" });
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

// A single hyphen between two words makes one term ("sense-data", "self-evident"); a dash or "--" does not.
const HYPHENS = new Set(["-", "\u2010", "\u2011"]);

// Borrowed phrases whose words mean nothing on their own in English: "priori" alone is no help to a reader.
const PHRASES = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    "a priori",
    "a posteriori",
    "a fortiori",
    "ad hoc",
    "ad hominem",
    "ad infinitum",
    "ad nauseam",
    "bona fide",
    "ceteris paribus",
    "de facto",
    "de jure",
    "en masse",
    "et al",
    "et cetera",
    "inter alia",
    "ipso facto",
    "modus operandi",
    "mutatis mutandis",
    "non sequitur",
    "par excellence",
    "per se",
    "prima facie",
    "quid pro quo",
    "reductio ad absurdum",
    "status quo",
    "sui generis",
    "tabula rasa",
    "vice versa",
  ]
    .map((phrase) => phrase.replaceAll(" ", "\\s+"))
    .join("|")})(?![\\p{L}\\p{N}])`,
  "giu",
);

/**
 * The word touching `offset`, or null when the offset sits in spaces or punctuation.
 * A hyphenated term ("sense-data") or a borrowed phrase ("a priori") counts as one word.
 */
export function wordAt(text: string, offset: number): Span | null {
  const parts = [...words.segment(text)];
  const hit = parts.findIndex(
    (part) => part.isWordLike && offset >= part.index && offset <= part.index + part.segment.length,
  );
  if (hit === -1) return null;
  const joins = (i: number) =>
    HYPHENS.has(parts[i]?.segment ?? "") && Boolean(parts[i - 1]?.isWordLike && parts[i + 1]?.isWordLike);
  let first = hit;
  while (joins(first - 1)) first -= 2;
  let last = hit;
  while (joins(last + 1)) last += 2;
  const end = parts[last]!;
  const word = { start: parts[first]!.index, end: end.index + end.segment.length };
  for (const match of text.matchAll(PHRASES)) {
    const phrase = { start: match.index, end: match.index + match[0].length };
    if (phrase.start <= word.start && word.end <= phrase.end) return phrase;
    if (phrase.start > word.end) break;
  }
  return word;
}

/** The word after `from` (or before it when `step` is -1); with no `from`, the first (or last) word. Null past the end. */
export function stepWord(text: string, from: Span | null, step: 1 | -1): Span | null {
  const parts = [...words.segment(text)].filter((part) => part.isWordLike);
  const next =
    step === 1
      ? parts.find((part) => part.index >= (from?.end ?? 0))
      : parts.findLast((part) => part.index + part.segment.length <= (from?.start ?? text.length));
  return next ? wordAt(text, next.index) : null;
}

/** Where the term sits in a short selection ("a priori", "common sense"), or null when the selection is a passage. */
export function termSpan(text: string): Span | null {
  // From the first letter or digit to the last, leaving out quotes and full stops picked up by the drag.
  const match = /[\p{L}\p{N}](?:[\s\S]*[\p{L}\p{N}])?/u.exec(text);
  if (!match) return null;
  const term = match[0];
  const isTerm =
    term.length <= 40 && /^[\p{L}\p{M}\p{N}'\u2019\u2010\u2011\s-]+$/u.test(term) && term.split(/\s+/).length <= 3;
  return isTerm ? { start: match.index, end: match.index + term.length } : null;
}

// Titles and citation words that a name or phrase always follows, never a new sentence. "etc." is left out: it usually does end one.
const ABBREVIATIONS = new Set(
  "mr. mrs. ms. dr. prof. st. mt. messrs. rev. capt. col. gen. lt. sgt. cf. e.g. i.e. viz. vs.".split(" "),
);

// Words that open a sentence far more often than a surname does: "of A and B. There may be" ends at "B.".
const OPENERS = new Set(
  `the a an this that these those there here it its he she they we you i in on at by for from to of with as if but and or
  so thus hence then now when where while what which who how why one some all any no not such let our his her their my
  your is are was were do does did can may must shall will should would could yet still however therefore also even
  only each every both many most other another since because although though after before until unless whether nor
  perhaps indeed`.split(/\s+/),
);

/** The segmenter breaks after "G." in "G. E. Moore" and after "Mr.": whether `next` carries on the sentence `before`. */
function continues(text: string, before: Span, next: Span): boolean {
  const last = /\S+$/.exec(text.slice(before.start, before.end))?.[0].replace(/^[("'\u2018\u201c[]+/, "") ?? "";
  if (ABBREVIATIONS.has(last.toLowerCase())) return true;
  // An initial or a dotted acronym ("G.", "U.S."): it ends the sentence only when a sentence opener comes next.
  if (!/^(?:\p{Lu}\.)+$/u.test(last)) return false;
  const after = text.slice(next.start, next.end);
  if (/^\p{Lu}\.(?:\s|$)/u.test(after)) return true;
  const word = /^[("'\u2018\u201c[]*(\p{Lu}[\p{L}'\u2019-]*)/u.exec(after)?.[1];
  return word !== undefined && !OPENERS.has(word.toLowerCase());
}

/** Sentences of `text` with surrounding whitespace trimmed off. */
export function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const part of sentences.segment(text)) {
    const trimmed = part.segment.trim();
    if (!trimmed) continue;
    const start = part.index + part.segment.indexOf(trimmed);
    const span = { start, end: start + trimmed.length };
    const before = spans.at(-1);
    if (before && continues(text, before, span)) before.end = span.end;
    else spans.push(span);
  }
  return spans;
}

// Blocks never change once loaded, so each is split once, not again every time a chapter is appended.
const splitBlocks = new WeakMap<Block, Sentence[]>();

// A heading is a title, not prose: "CHAPTER I. APPEARANCE AND REALITY" is one thing to say, not two sentences.
// A long "heading" is more likely a paragraph the parser mistook for one, so it is split like any text.
const MAX_HEADING = 160;

function spansOf(block: Block): Span[] {
  if (block.type !== "heading" || block.text.length > MAX_HEADING) return sentenceSpans(block.text);
  const title = block.text.trim();
  return title ? [{ start: block.text.indexOf(title), end: block.text.indexOf(title) + title.length }] : [];
}

/** Every sentence of `blocks`, in reading order. */
export function sentencesOf(blocks: Block[]): Sentence[] {
  return blocks.flatMap((block) => {
    let list = splitBlocks.get(block);
    if (!list) {
      list = spansOf(block).map((span) => ({
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

/** A range over part of a rendered block (or chapter title), or null if it is not on the page. */
export function rangeInBlock(blockId: string, span: Span): Range | null {
  // A chapter's title is read like a block but is not one: it is found by its id.
  const element = document.querySelector(`[data-block="${CSS.escape(blockId)}"]`) ?? document.getElementById(blockId);
  const node = element?.firstChild;
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
