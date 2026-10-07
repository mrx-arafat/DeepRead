import type { Chapter, Note } from "../../shared/types.ts";

export type NotebookSource = { chapterId: string; blockId: string; offset: number; matchLength: number };

/** Find the stored passage without falling back to a different occurrence. */
export function notebookSource(note: Note, chapter: Chapter): NotebookSource | null {
  if (chapter.id !== note.chapterId) return null;
  const blockIndex = chapter.blocks.findIndex((item) => item.id === note.blockId);
  const block = chapter.blocks[blockIndex];
  const parts = note.quote.split(/\s*\n\s*/);
  const firstLine = parts[0];
  if (!block || !firstLine) return null;
  const storedOffset = "offset" in note ? note.offset : undefined;
  const hasOffset = typeof storedOffset === "number";
  const offset = hasOffset ? storedOffset : block.text.indexOf(firstLine);
  if (!Number.isInteger(offset) || offset < 0 || block.text.slice(offset, offset + firstLine.length) !== firstLine) return null;
  if (!hasOffset && block.text.indexOf(firstLine, offset + 1) !== -1) return null;
  if (parts.length > 1) {
    if (block.text.slice(offset) !== firstLine) return null;
    for (let index = 1; index < parts.length; index += 1) {
      const part = parts[index];
      const next = chapter.blocks[blockIndex + index];
      if (!part || !next || (index === parts.length - 1 ? !next.text.startsWith(part) : next.text !== part)) return null;
    }
  }
  return { chapterId: chapter.id, blockId: block.id, offset, matchLength: firstLine.length };
}
