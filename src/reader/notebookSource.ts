import type { Chapter, Note } from "../../shared/types.ts";
import { matchQuoteAt } from "./quoteSource.ts";

export type NotebookSource = { chapterId: string; blockId: string; offset: number; matchLength: number };

/** Find the stored passage without falling back to a different occurrence. */
export function notebookSource(note: Note, chapter: Chapter): NotebookSource | null {
  if (chapter.id !== note.chapterId) return null;
  const blocks = chapter.blocks.filter((item) => item.type !== "image" && item.text.trim() !== "");
  const blockIndex = blocks.findIndex((item) => item.id === note.blockId);
  const block = blocks[blockIndex];
  const parts = note.quote.split(/\s*\n\s*/);
  const firstLine = parts[0];
  if (!block || !firstLine) return null;
  const storedOffset = "offset" in note ? note.offset : undefined;
  const hasOffset = typeof storedOffset === "number";
  // Code preserves line breaks within one block; first try the complete quote against that exact text.
  const wholeOffset = hasOffset ? storedOffset : block.text.indexOf(note.quote);
  if (Number.isInteger(wholeOffset) && wholeOffset >= 0 && block.text.startsWith(note.quote, wholeOffset)) {
    if (!hasOffset && block.text.indexOf(note.quote, wholeOffset + 1) !== -1) return null;
    return { chapterId: chapter.id, blockId: block.id, offset: wholeOffset, matchLength: note.quote.length };
  }
  const offset = hasOffset ? storedOffset : block.text.indexOf(firstLine);
  if (!Number.isInteger(offset) || offset < 0 || block.text.slice(offset, offset + firstLine.length) !== firstLine) return null;
  if (!hasOffset && block.text.indexOf(firstLine, offset + 1) !== -1) return null;
  const match = matchQuoteAt(blocks, blockIndex, note.quote, offset)?.[0];
  if (!match) return null;
  return { chapterId: chapter.id, blockId: block.id, offset, matchLength: match.span.end - match.span.start };
}
