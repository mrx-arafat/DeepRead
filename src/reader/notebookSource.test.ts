import { describe, expect, it } from "vitest";
import type { Chapter, HighlightNote, QuestionNote } from "../../shared/types.ts";
import { notebookSource } from "./notebookSource.ts";

const chapter: Chapter = {
  id: "c2", title: "Repeated words", startPage: 2, endPage: 2,
  blocks: [
    { id: "c2-b1", type: "paragraph", text: "Echo once. Echo again. Then quiet.", page: 2 },
  ],
};

const highlight: HighlightNote = {
  id: "h1", chapterId: "c2", blockId: "c2-b1", quote: "Echo", offset: 11,
  lang: "bn", mode: "highlight", color: "yellow",
};

describe("notebookSource", () => {
  it("should preserve the selected occurrence of repeated text", () => {
    expect(notebookSource(highlight, chapter)).toEqual({ chapterId: "c2", blockId: "c2-b1", offset: 11, matchLength: 4 });
  });

  it("should refuse stale offsets and missing anchors", () => {
    expect(notebookSource({ ...highlight, offset: 5 }, chapter)).toBeNull();
    expect(notebookSource({ ...highlight, blockId: "missing" }, chapter)).toBeNull();
    expect(notebookSource(highlight, { ...chapter, id: "different" })).toBeNull();
  });

  it("should open legacy questions only when their quote is unique", () => {
    const question: QuestionNote = { id: "q1", chapterId: "c2", blockId: "c2-b1", quote: "Then quiet", lang: "bn", mode: "simple" };
    expect(notebookSource(question, chapter)).toEqual({ chapterId: "c2", blockId: "c2-b1", offset: 23, matchLength: 10 });
    expect(notebookSource({ ...question, quote: "Echo" }, chapter)).toBeNull();
  });

  it("should refuse a multi-block quote when any later passage changed", () => {
    const across: Chapter = { ...chapter, blocks: [
      { id: "c2-b1", type: "paragraph", text: "Before the end", page: 2 },
      { id: "c2-b2", type: "paragraph", text: "a new beginning after that", page: 2 },
    ] };
    const note = { ...highlight, quote: "the end\na new beginning", offset: 7 };
    expect(notebookSource(note, across)).toEqual({ chapterId: "c2", blockId: "c2-b1", offset: 7, matchLength: 7 });
    expect(notebookSource(note, { ...across, blocks: [across.blocks[0]!, { ...across.blocks[1]!, text: "an altered beginning after that" }] })).toBeNull();
  });
});
