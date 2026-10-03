import { describe, expect, it } from "vitest";
import type { Block, ChapterSummary } from "../../shared/types.ts";
import { bookPercent, chapterPosition, indexAtLine, nextInFlow, openingChapter, previousInFlow } from "./book.ts";
import { sentenceIndex, sentencesOf } from "./textRanges.ts";

const section = (id: string, wordCount: number, kind?: ChapterSummary["kind"]): ChapterSummary => ({
  id,
  title: id,
  kind,
  startPage: 1,
  endPage: 1,
  wordCount,
});

describe("indexAtLine", () => {
  // Three chapters stacked down the page: their bottom edges, in px from the top of the window.
  const bottoms = [400, 900, 1500];
  const at = (line: number) => indexAtLine(bottoms.length, (index) => bottoms[index] ?? 0, line);

  it("should give the first chapter when the eye line is above all of them", () => {
    // The way back to earlier chapters sits above the first one on the page.
    expect(at(-200)).toBe(0);
  });

  it("should give the chapter the eye line falls in", () => {
    expect(at(400)).toBe(1);
    expect(at(1499)).toBe(2);
  });

  it("should give the count when every item ends above the eye line", () => {
    expect(at(1600)).toBe(3);
  });
});

describe("bookPercent", () => {
  // Parsed before sections had kinds: every chapter counts.
  const chapters = [section("c1", 100), section("c2", 300), section("c3", 600)];

  it("should count earlier chapters plus the passed part of the current one when the reader is mid-book", () => {
    // 100 words of chapter one + half of chapter two's 300, out of 1000.
    expect(bookPercent(chapters, "c2", 0.5)).toBe(25);
  });

  it("should not show 100 when the last chapter is not fully passed", () => {
    expect(bookPercent(chapters, "c3", 0.999)).toBe(99);
  });

  it("should leave front and back matter out when the book has them", () => {
    const wrapped = [section("c1", 100, "front"), section("c2", 300, "body"), section("c3", 600, "body"), section("c4", 2000, "back")];
    // Half of chapter two's 300 words, out of the 900 words of the book's own text.
    expect(bookPercent(wrapped, "c2", 0.5)).toBe(16);
    expect(bookPercent(wrapped, "c1", 0.9)).toBe(0);
    expect(bookPercent(wrapped, "c4", 0)).toBe(100);
  });
});

describe("the flow through a book with front and back matter", () => {
  const chapters = [section("c1", 50, "front"), section("c2", 300, "body"), section("c3", 600, "body"), section("c4", 80, "back"), section("c5", 900, "back")];

  it("should open at the first section of the book's own text when nothing was read yet", () => {
    expect(openingChapter(chapters)?.id).toBe("c2");
  });

  it("should end after the last chapter and not run on into the back matter", () => {
    expect(nextInFlow(chapters, "c1")?.id).toBe("c2");
    expect(nextInFlow(chapters, "c3")).toBeUndefined();
  });

  it("should carry on through the back matter when the reader opened it on purpose", () => {
    expect(nextInFlow(chapters, "c4")?.id).toBe("c5");
    expect(nextInFlow(chapters, "c5")).toBeUndefined();
  });

  it("should open the chapter before as the reader scrolls up, but not run back into the front matter", () => {
    expect(previousInFlow(chapters, "c3")?.id).toBe("c2");
    expect(previousInFlow(chapters, "c4")?.id).toBe("c3");
    expect(previousInFlow(chapters, "c2")).toBeUndefined();
    expect(previousInFlow(chapters, "c1")).toBeUndefined();
  });
});

describe("chapterPosition", () => {
  const titled = (id: string, title: string, kind: ChapterSummary["kind"]) => ({ ...section(id, 100, kind), title });

  it("should count the chapters of the book's own text when their titles carry no number", () => {
    const chapters = [titled("c1", "Front Matter", "front"), titled("c2", "It's All Invented", "body"), titled("c3", "Being a Contribution", "body")];
    expect(chapterPosition(chapters, "c3")).toEqual({ number: 2, count: 2 });
    expect(chapterPosition(chapters, "c1")).toBeUndefined();
  });

  it("should give no number of its own when the book numbers its chapters, so a preface cannot put 2 above CHAPTER I", () => {
    const chapters = [
      titled("c1", "Front Matter", "front"),
      titled("c2", "PREFACE", "body"),
      titled("c3", "CHAPTER I. APPEARANCE AND REALITY", "body"),
      titled("c4", "CHAPTER II. THE EXISTENCE OF MATTER", "body"),
    ];
    expect(chapterPosition(chapters, "c2")).toBeUndefined();
    expect(chapterPosition(chapters, "c3")).toBeUndefined();
    expect(chapterPosition([titled("c1", "1. It's All Invented", "body"), titled("c2", "2. Being a Contribution", "body")], "c2")).toBeUndefined();
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
