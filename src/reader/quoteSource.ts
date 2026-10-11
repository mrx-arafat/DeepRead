import type { Block } from "../../shared/types.ts";

export type QuotePiece = {
  blockId: string;
  span: { start: number; end: number };
};

/** Match actual block text before interpreting a newline as a boundary: code can contain its own newlines. */
export function matchQuoteAt(
  blocks: Block[],
  at: number,
  quote: string,
  offset: number,
): QuotePiece[] | null {
  const block = blocks[at];
  if (
    !block ||
    !quote ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset >= block.text.length
  )
    return null;
  if (block.text.startsWith(quote, offset)) {
    return [
      {
        blockId: block.id,
        span: { start: offset, end: offset + quote.length },
      },
    ];
  }
  const suffix = block.text.slice(offset);
  if (!quote.startsWith(suffix)) return null;
  const rest = quote.slice(suffix.length);
  const boundary = /^\s*\n\s*/.exec(rest)?.[0];
  if (!boundary) return null;
  // Try the literal block separator first, preserving indentation at the beginning of the next code block.
  // Older selections use blank lines and surrounding spaces between paragraphs, so accept those too.
  const separators = rest.startsWith("\n")
    ? [...new Set(["\n", boundary])]
    : [boundary];
  for (const separator of separators) {
    const next = matchQuoteAt(blocks, at + 1, rest.slice(separator.length), 0);
    if (next)
      return [
        { blockId: block.id, span: { start: offset, end: block.text.length } },
        ...next,
      ];
  }
  return null;
}
