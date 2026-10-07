import { describe, expect, it } from "vitest";
import type { Chapter } from "../../shared/types.ts";
import { searchChapter } from "./bookSearch.ts";

const chapter: Chapter = {
  id: "c2", title: "A quiet chapter", startPage: 4, endPage: 6,
  blocks: [
    { id: "c2-b1", type: "heading", text: "The Echo", page: 4 },
    { id: "c2-b2", type: "paragraph", text: "An echo, then another ECHO. The echo remains.", page: 4 },
    { id: "c2-b3", type: "paragraph", text: "A [small] sign beside the road.", page: 5 },
  ],
};

describe("searchChapter", () => {
  it("should find each repeated literal occurrence at its exact source offset", () => {
    const results = searchChapter(chapter, "echo");
    expect(results.map(({ chapterId, chapterTitle, blockId, offset }) => ({ chapterId, chapterTitle, blockId, offset }))).toEqual([
      { chapterId: "c2", chapterTitle: "A quiet chapter", blockId: "c2-b1", offset: 4 },
      { chapterId: "c2", chapterTitle: "A quiet chapter", blockId: "c2-b2", offset: 3 },
      { chapterId: "c2", chapterTitle: "A quiet chapter", blockId: "c2-b2", offset: 22 },
      { chapterId: "c2", chapterTitle: "A quiet chapter", blockId: "c2-b2", offset: 32 },
    ]);
    for (const result of results) {
      expect(result.excerpt.slice(result.matchStart, result.matchStart + result.matchLength).toLowerCase()).toBe("echo");
      expect(result.excerpt.length).toBeLessThanOrEqual(220);
    }
  });

  it("should treat regex punctuation as ordinary text and ignore blank searches", () => {
    expect(searchChapter(chapter, "[small]").map(({ blockId, offset }) => ({ blockId, offset }))).toEqual([
      { blockId: "c2-b3", offset: 2 },
    ]);
    expect(searchChapter(chapter, "  ")).toEqual([]);
  });

  it("should apply a deterministic result cap in chapter and block order", () => {
    expect(searchChapter(chapter, "echo", 2).map((result) => result.offset)).toEqual([4, 3]);
    expect(searchChapter(chapter, "echo", 0)).toEqual([]);
    expect(searchChapter(chapter, "echo", Number.NaN)).toEqual([]);
  });

  it("should keep a long passage excerpt compact without losing the located match", () => {
    const long = { ...chapter, blocks: [{ ...chapter.blocks[1]!, text: `${"before ".repeat(60)}NEEDLE ${"after ".repeat(60)}` }] };
    const [result] = searchChapter(long, "needle");
    expect(result?.offset).toBe(420);
    expect(result?.excerpt.length).toBeLessThanOrEqual(220);
    expect(result?.excerpt).toContain("NEEDLE");
    expect(result?.excerpt.slice(result.matchStart, result.matchStart + result.matchLength)).toBe("NEEDLE");
  });
});
