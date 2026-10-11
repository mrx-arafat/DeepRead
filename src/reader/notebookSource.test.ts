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

  it("restores an exact multiline code passage at its recorded occurrence", () => {
    const code = "before\n  return value;\n  next();\nafter";
    const source: Chapter = { ...chapter, blocks: [{ id: "c2-b1", type: "code", text: code, page: 2 }] };
    const quote = "  return value;\n  next();";
    const offset = code.indexOf(quote);
    expect(notebookSource({ ...highlight, quote, offset }, source)).toEqual({ chapterId: "c2", blockId: "c2-b1", offset, matchLength: quote.length });
    expect(notebookSource({ ...highlight, quote, offset: offset + 1 }, source)).toBeNull();
  });

  it.each([
    { first: "alpha\nbeta", firstType: "code" as const, second: "gamma", secondType: "paragraph" as const, quote: "alpha\nbeta\ngamma", offset: 0 },
    { first: "intro", firstType: "paragraph" as const, second: "  alpha\nbeta", secondType: "code" as const, quote: "intro\n  alpha\nbeta", offset: 0 },
    { first: "before\n  alpha\nbeta", firstType: "code" as const, second: "gamma after", secondType: "paragraph" as const, quote: "alpha\nbeta\ngamma", offset: 9 },
    { first: "before intro", firstType: "paragraph" as const, second: "next paragraph", secondType: "paragraph" as const, quote: "intro \n\n  next", offset: 7 },
  ])("restores a cross-block quote with embedded newlines: $quote", ({ first, firstType, second, secondType, quote, offset }) => {
    const source: Chapter = { ...chapter, blocks: [
      { id: "c2-b1", type: firstType, text: first, page: 2 },
      { id: "figure", type: "image", text: "", page: 2 },
      { id: "next", type: secondType, text: second, page: 2 },
    ] };
    const note = { ...highlight, quote, offset };
    expect(notebookSource(note, source)).toEqual({ chapterId: "c2", blockId: "c2-b1", offset, matchLength: first.length - offset });
    expect(notebookSource({ ...note, offset: offset + 1 }, source)).toBeNull();
    expect(notebookSource(note, { ...source, blocks: [...source.blocks.slice(0, 2), { ...source.blocks[2]!, text: "changed" }] })).toBeNull();
  });

  it("restores a passage across a figure and empty blocks without accepting altered text", () => {
    const source: Chapter = { ...chapter, blocks: [
      { id: "c2-b1", type: "paragraph", text: "Before the end", page: 2 },
      { id: "figure", type: "image", text: "", page: 2 },
      { id: "empty", type: "paragraph", text: " ", page: 2 },
      { id: "next", type: "paragraph", text: "a new beginning after that", page: 2 },
    ] };
    const note = { ...highlight, quote: "the end\na new beginning", offset: 7 };
    expect(notebookSource(note, source)).toEqual({ chapterId: "c2", blockId: "c2-b1", offset: 7, matchLength: 7 });
    expect(notebookSource(note, { ...source, blocks: [...source.blocks.slice(0, 3), { ...source.blocks[3]!, text: "an altered beginning" }] })).toBeNull();
  });
});
