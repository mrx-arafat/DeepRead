import { describe, expect, it, vi } from "vitest";
import type { Block, HighlightNote, QuestionNote } from "../../shared/types.ts";
import { closingMarks, sentencesOf } from "./ChapterClosing.tsx";

// prefs.ts applies the saved look to the page as it loads; these tests have no page.
vi.mock("../prefs.ts", () => ({ usePrefs: () => ({ chapterNotes: true }) }));

const block = (id: string, text: string): Block => ({ id, type: "paragraph", text, page: 1 });
const highlight = (chapterId: string, blockId: string, quote: string, offset: number): HighlightNote => ({
  id: `${blockId}-${offset}`,
  chapterId,
  blockId,
  quote,
  offset,
  lang: "bn",
  mode: "highlight",
  color: "yellow",
});
const question = (chapterId: string, blockId: string, quote: string, mode: QuestionNote["mode"]): QuestionNote => ({
  id: `${blockId}-${quote}`,
  chapterId,
  blockId,
  quote,
  lang: "bn",
  mode,
});

describe("closingMarks", () => {
  it("should list only the marks on the chapter's blocks, in reading order by block and then by where each starts", () => {
    const blocks = [block("c2-b1", "Alpha beta gamma delta."), block("c2-b2", "Epsilon zeta eta theta.")];
    const highlights = [
      highlight("c2", "c2-b2", "zeta", 8),
      highlight("c3", "c3-b1", "elsewhere", 0),
      highlight("c2", "c2-b1", "gamma", 11),
      highlight("c2", "c2-b1", "Alpha", 0),
    ];
    const notes = [question("c2", "c2-b2", "theta", "word"), question("c2", "c2-b1", "beta", "simple")];

    expect(closingMarks(blocks, notes, highlights)).toEqual([
      { quote: "Alpha", mode: "highlight" },
      { quote: "beta", mode: "simple" },
      { quote: "gamma", mode: "highlight" },
      { quote: "zeta", mode: "highlight" },
      { quote: "theta", mode: "word" },
    ]);
  });
});

describe("sentencesOf", () => {
  it("should split the line where one sentence ends and the next begins, and nowhere else", () => {
    expect(sentencesOf("About 3 hours of reading remain. The next one is shorter, about 14 minutes.")).toEqual([
      "About 3 hours of reading remain.",
      "The next one is shorter, about 14 minutes.",
    ]);
    // A quoted passage ending the first sentence, and "e.g." before a small letter, are no break.
    expect(sentencesOf('You kept two passages from this chapter. The first: "e.g. the table".')).toEqual([
      "You kept two passages from this chapter.",
      'The first: "e.g. the table".',
    ]);
    expect(sentencesOf('You can now say why "it always has." Next, the book asks how.')).toEqual([
      'You can now say why "it always has."',
      "Next, the book asks how.",
    ]);
  });
});
