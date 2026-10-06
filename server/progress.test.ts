import { describe, expect, it } from "vitest";
import type { Block, ParsedBook } from "../shared/types.ts";
import { describePosition } from "./progress.ts";

const paragraph = (id: string): Block => ({ id, type: "paragraph", text: "Some words here.", page: 1 });

// Chapter two opens with a heading that repeats its title, which the reader does not show.
const book: ParsedBook = {
  title: "Sample",
  author: null,
  pageCount: 9,
  warnings: [],
  chapters: [
    { id: "c1", title: "One", startPage: 1, endPage: 2, blocks: [paragraph("c1-b1")] },
    {
      id: "c2",
      title: "Two",
      startPage: 3,
      endPage: 5,
      blocks: [
        { id: "c2-b0", type: "heading", level: 1, text: "Two", page: 3 },
        paragraph("c2-b1"),
        paragraph("c2-b2"),
        paragraph("c2-b3"),
        paragraph("c2-b4"),
      ],
    },
    { id: "c3", title: "Three", startPage: 6, endPage: 9, blocks: [paragraph("c3-b1")] },
  ],
};
const wordCounts = { c1: 100, c2: 300, c3: 600 };

describe("describePosition", () => {
  it("should count earlier chapters plus the part of this one above the block when the reader is mid-chapter", () => {
    // Block 3 of 4 readable blocks: half of chapter two's 300 words, after chapter one's 100, out of 1000.
    expect(describePosition(book, wordCounts, "c2", "c2-b3")).toEqual({ chapterTitle: "Two", percent: 25 });
  });

  it("should treat the first paragraph as the start of the chapter when a heading repeating the title comes before it", () => {
    expect(describePosition(book, wordCounts, "c2", "c2-b1")).toEqual({ chapterTitle: "Two", percent: 10 });
  });

  it("should weigh blocks by their length and count the line the reader is on, so a long paragraph is more of a chapter than a short one", () => {
    const uneven: ParsedBook = {
      ...book,
      chapters: [
        book.chapters[0]!,
        {
          id: "c2",
          title: "Two",
          startPage: 3,
          endPage: 5,
          blocks: [
            { id: "c2-b1", type: "paragraph", text: "x".repeat(100), page: 3 },
            { id: "c2-b2", type: "paragraph", text: "x".repeat(300), page: 4 },
          ],
        },
        book.chapters[2]!,
      ],
    };
    // 100 + 150 of 400 characters is 62.5% of chapter two's 300 words: 187.5 and chapter one's 100, of 1000.
    expect(describePosition(uneven, wordCounts, "c2", "c2-b2", 150)).toEqual({ chapterTitle: "Two", percent: 28 });
    // At the start of the second block only the short first one is above: a quarter of the chapter, not the half block counting gave.
    expect(describePosition(uneven, wordCounts, "c2", "c2-b2")).toEqual({ chapterTitle: "Two", percent: 17 });
  });

  it("should return null when the chapter or block is not in the book", () => {
    expect(describePosition(book, wordCounts, "c9", "c9-b1")).toBeNull();
    expect(describePosition(book, wordCounts, "c2", "c2-b99")).toBeNull();
  });
});
