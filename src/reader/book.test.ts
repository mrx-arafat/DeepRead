import { describe, expect, it } from "vitest";
import type { Block, ChapterSummary } from "../../shared/types.ts";
import { bookPercent } from "./book.ts";
import { sentenceIndex, sentencesOf } from "./textRanges.ts";

describe("bookPercent", () => {
  const chapters: ChapterSummary[] = [
    { id: "c1", title: "One", startPage: 1, endPage: 2, wordCount: 100 },
    { id: "c2", title: "Two", startPage: 3, endPage: 5, wordCount: 300 },
    { id: "c3", title: "Three", startPage: 6, endPage: 9, wordCount: 600 },
  ];

  it("should count earlier chapters plus the passed part of the current one when the reader is mid-book", () => {
    // 100 words of chapter one + half of chapter two's 300, out of 1000.
    expect(bookPercent(chapters, 1000, "c2", 0.5)).toBe(25);
  });

  it("should not show 100 when the last chapter is not fully passed", () => {
    expect(bookPercent(chapters, 1000, "c3", 0.999)).toBe(99);
  });
});

describe("sentenceIndex", () => {
  const first: Block = { id: "c1-b1", type: "paragraph", text: "One. Two.", page: 1 };
  const second: Block = { id: "c2-b1", type: "paragraph", text: "Three.", page: 2 };

  it("should find the same sentence and the one after it when the next chapter is appended", () => {
    const sentences = sentencesOf([first, second]);
    const index = sentenceIndex(sentences, { blockId: "c1-b1", start: 5 });
    expect(sentences[index]?.text).toBe("Two.");
    expect(sentences[index + 1]?.text).toBe("Three.");
  });

  it("should return -1 when the position is no longer on the page", () => {
    expect(sentenceIndex(sentencesOf([second]), { blockId: "c1-b1", start: 5 })).toBe(-1);
  });
});
