// Where a selection sits among the reader's highlights: whether highlighting it makes a new highlight or changes the
// one it lies in. Both sides are found in the text the same way (quoteSpans), so what is painted is what is decided on.
import { HIGHLIGHT_COLORS } from "../../shared/types.ts";
import type { Block, HighlightNote } from "../../shared/types.ts";
import { quoteSpans } from "./textRanges.ts";

/** Where some selected words start: in which block, and how many characters into its text. */
export type QuoteAt = { blockId: string; offset: number };

/**
 * Where the selected `quote` starts: in block `blockId` at or after `from`, where the selection starts in that block's
 * text. Null when its words are not there.
 */
export function quoteStart(blocks: Block[], blockId: string, quote: string, from: number): QuoteAt | null {
  const at = blocks.findIndex((block) => block.id === blockId);
  // A selection over several paragraphs breaks lines between them: its first line is where it starts.
  const first = quote.split(/\s*\n\s*/)[0] ?? "";
  if (at === -1 || !first) return null;
  const offset = blocks[at]!.text.indexOf(first, from);
  if (offset !== -1) return { blockId, offset };
  // Dragged from past a paragraph's last word, the selected words start in the next one.
  const next = blocks[at + 1];
  return next?.text.startsWith(first) ? { blockId: next.id, offset: 0 } : null;
}

/** What highlighting some words would mark: where they start, the words, and the highlight they already lie inside. */
export type HighlightTarget = QuoteAt & { quote: string; around: HighlightNote | null };

/**
 * What highlighting a selection, or a word or term looked up in the word card, works on: the same for both, so either
 * finds the highlight the other made. `from` is where the words' range starts in block `blockId`'s text.
 */
export function highlightTarget(
  blocks: Block[],
  highlights: HighlightNote[],
  words: { blockId: string; quote: string; from: number },
): HighlightTarget | null {
  const at = quoteStart(blocks, words.blockId, words.quote, words.from);
  return at && { ...at, quote: words.quote, around: highlightAround(highlights, blocks, { ...at, quote: words.quote }) };
}

/**
 * The highlight a selection lies entirely inside, if any: every word of it within that one highlight. Where several
 * hold it, the one the reader sees there: painted on top (the later colour, as textRanges.ts layers them), else the newer.
 */
export function highlightAround(highlights: HighlightNote[], blocks: Block[], selection: QuoteAt & { quote: string }): HighlightNote | null {
  const inner = quoteSpans(blocks, selection.blockId, selection.quote, selection.offset);
  if (inner.length === 0) return null;
  const layer = (highlight: HighlightNote) => HIGHLIGHT_COLORS.indexOf(highlight.color);
  let top: HighlightNote | null = null;
  for (const highlight of highlights) {
    const outer = quoteSpans(blocks, highlight.blockId, highlight.quote, highlight.offset);
    const holds = inner.every(({ blockId, span }) =>
      outer.some((mark) => mark.blockId === blockId && mark.span.start <= span.start && span.end <= mark.span.end),
    );
    // Highlights come oldest first, so a later one of the same colour takes over.
    if (holds && (!top || layer(highlight) >= layer(top))) top = highlight;
  }
  return top;
}
