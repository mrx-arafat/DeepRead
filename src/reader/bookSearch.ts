import type { Chapter } from "../../shared/types.ts";

export const MAX_SEARCH_RESULTS = 50;
export const MAX_SEARCH_QUERY_LENGTH = 120;

export interface BookSearchResult {
  chapterId: string;
  chapterTitle: string;
  blockId: string;
  /** UTF-16 character offset in the original block text, not the excerpt. */
  offset: number;
  excerpt: string;
  matchStart: number;
  matchLength: number;
}

function excerptAround(text: string, offset: number, length: number): Pick<BookSearchResult, "excerpt" | "matchStart" | "matchLength"> {
  const context = Math.floor((180 - length) / 2);
  const start = Math.max(0, offset - context);
  const end = Math.min(text.length, offset + length + context);
  const prefix = start ? "..." : "";
  return {
    excerpt: `${prefix}${text.slice(start, end)}${end < text.length ? "..." : ""}`,
    matchStart: prefix.length + offset - start,
    matchLength: length,
  };
}

/** Find literal text in one chapter without fetching or retaining book content. */
export function searchChapter(chapter: Chapter, query: string, limit = MAX_SEARCH_RESULTS): BookSearchResult[] {
  const needle = query.trim();
  const cap = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 0), MAX_SEARCH_RESULTS) : 0;
  if (!needle || needle.length > MAX_SEARCH_QUERY_LENGTH || !cap) return [];

  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const results: BookSearchResult[] = [];
  for (const block of chapter.blocks) {
    pattern.lastIndex = 0;
    for (const match of block.text.matchAll(pattern)) {
      results.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        blockId: block.id,
        offset: match.index,
        ...excerptAround(block.text, match.index, match[0].length),
      });
      if (results.length === cap) return results;
    }
  }
  return results;
}
