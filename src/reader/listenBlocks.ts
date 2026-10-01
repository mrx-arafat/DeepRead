// What the voice reads: each chapter's title (spoken like an audiobook's chapter cue), then its text.

import type { Block, Chapter } from "../../shared/types.ts";
import { readableBlocks } from "./book.ts";

/** The id of a chapter's title element, which is also the id of its spoken block so the title can be highlighted. */
export const titleId = (chapterId: string): string => `chapter-title-${chapterId}`;

/** Every block read aloud for `chapters`, in order. */
export function listenBlocks(chapters: Chapter[]): Block[] {
  return chapters.flatMap((chapter) => [
    { id: titleId(chapter.id), type: "heading", level: 1, text: chapter.title, page: chapter.blocks[0]?.page ?? chapter.startPage },
    ...readableBlocks(chapter),
  ]);
}
