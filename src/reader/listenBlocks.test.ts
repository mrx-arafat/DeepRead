import { describe, expect, it } from "vitest";
import type { Block, Chapter } from "../../shared/types.ts";
import { listenBlocks } from "./listenBlocks.ts";
import { sentencesOf } from "./textRanges.ts";

const block = (id: string, type: Block["type"], text: string): Block => ({ id, type, text, page: 2 });

describe("what is read aloud", () => {
  const chapters: Chapter[] = [
    {
      id: "c3",
      title: "CHAPTER I. APPEARANCE AND REALITY",
      startPage: 2,
      endPage: 5,
      // The chapter's own first block repeats its title, as the parser leaves it.
      blocks: [block("c3-b1", "heading", "CHAPTER I. APPEARANCE AND REALITY"), block("c3-b2", "paragraph", "Is there any knowledge in the world?")],
    },
    {
      id: "c4",
      title: "CHAPTER II. THE EXISTENCE OF MATTER",
      startPage: 5,
      endPage: 8,
      blocks: [block("c4-b1", "paragraph", "In this chapter we have to ask whether matter exists.")],
    },
  ];

  it("should read each chapter's title once, as one sentence, before its text", () => {
    const spoken = sentencesOf(listenBlocks(chapters)).map((sentence) => sentence.text);
    expect(spoken).toEqual([
      "CHAPTER I. APPEARANCE AND REALITY",
      "Is there any knowledge in the world?",
      "CHAPTER II. THE EXISTENCE OF MATTER",
      "In this chapter we have to ask whether matter exists.",
    ]);
  });

  it("skips figures and empty blocks while reading recovered text and code", () => {
    const chapter: Chapter = {
      id: "c1", title: "Illustrations", startPage: 1, endPage: 1,
      blocks: [block("figure", "image", ""), block("empty", "paragraph", "  "), block("ocr", "paragraph", "Recovered words."), block("code", "code", "return value;")],
    };
    expect(listenBlocks([chapter]).map(({ id }) => id)).toEqual(["chapter-title-c1", "ocr", "code"]);
  });
});
