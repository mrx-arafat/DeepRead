import { describe, expect, it } from "vitest";
import type { ChapterSummary } from "../../shared/types.ts";
import { closingPreset, type ClosingFacts } from "./closingPresets.ts";

// A chapter's title is its id unless a test needs a real-looking one. Word counts are mostly multiples of 180, the
// reading pace, so the minutes in each expected line are whole numbers worked out by hand.
const section = (id: string, wordCount: number, kind?: ChapterSummary["kind"], title = id): ChapterSummary => ({
  id,
  title,
  kind,
  startPage: 1,
  endPage: 1,
  wordCount,
});

const preset = (chapters: ChapterSummary[], chapterId: string, marks: ClosingFacts["marks"] = []) =>
  closingPreset({ chapters, chapterId, marks });

const kept = (count: number): ClosingFacts["marks"] =>
  Array.from({ length: count }, (_, index) => ({ quote: `passage ${index + 1}`, mode: "highlight" as const }));

describe("closingPreset", () => {
  it("should give nothing for front or back matter, an unknown or short chapter, or a book of one chapter", () => {
    const book = [section("f", 900, "front"), section("t", 400), section("a", 900), section("b", 900), section("z", 900, "back")];
    expect(preset(book, "f")).toBeNull();
    expect(preset(book, "z")).toBeNull();
    expect(preset(book, "nope")).toBeNull();
    expect(preset(book, "t")).toBeNull();
    expect(preset([section("only", 900)], "only")).toBeNull();
    expect(preset([section("f", 900, "front"), section("only", 900, "body"), section("z", 900, "back")], "only")).toBeNull();
  });

  it("should start at 500 words", () => {
    // 499 gets nothing; 500 gets a line. Words 499, 500, 900 make 1899: this chapter ends at 999, past a third (633)
    // and a half (949.5) but not past two thirds.
    const book = [section("x", 499), section("y", 500), section("w", 900)];
    expect(preset(book, "x")).toBeNull();
    expect(preset(book, "y")).toBe("More of the book is behind you than ahead of you now. One chapter left: w, about 5 minutes.");
  });

  // Four chapters of 900 words (5 minutes each); the tests read the second.
  const even = [section("a", 900), section("b", 900), section("c", 900), section("d", 900)];

  it("should quote the one highlight the reader kept, tidied", () => {
    // The blank one counts for nothing. Spaces collapse, the outer single quotes go, the apostrophe stays.
    const marks: ClosingFacts["marks"] = [
      { quote: "   ", mode: "highlight" },
      { quote: "\n  \u2018It's   here\u2019 \n", mode: "highlight" },
    ];
    expect(preset(even, "b", marks)).toBe('Of everything here, you kept this: "It\'s here". The next one runs about 5 minutes.');
  });

  it("should count several highlights and quote the first, whatever questions came before", () => {
    const marks: ClosingFacts["marks"] = [
      { quote: "why?", mode: "simple" },
      { quote: "first kept", mode: "highlight" },
      { quote: "second kept", mode: "highlight" },
      { quote: "third kept", mode: "highlight" },
    ];
    expect(preset(even, "b", marks)).toBe(
      'You kept three passages from this chapter. The first: "first kept". The next one runs about 5 minutes.',
    );
  });

  it("should write the count in words up to ten and in digits after", () => {
    expect(preset(even, "b", kept(10))).toBe(
      'You kept ten passages from this chapter. The first: "passage 1". The next one runs about 5 minutes.',
    );
    expect(preset(even, "b", kept(11))).toBe(
      'You kept 11 passages from this chapter. The first: "passage 1". The next one runs about 5 minutes.',
    );
  });

  it("should mention the first question when there is no highlight", () => {
    const marks: ClosingFacts["marks"] = [
      { quote: "why  so?", mode: "example" },
      { quote: "other", mode: "word" },
    ];
    expect(preset(even, "b", marks)).toBe(
      'Your question about "why so?" stays in the margin, beside its passage. The next one runs about 5 minutes.',
    );
  });

  it("should cut a long quote before the word that crosses 90 characters and drop its quote marks", () => {
    // Cleaned, the ten words of 9 characters make 99 with their spaces. The tenth begins at character 90, so the cut
    // falls after the ninth, whose comma goes with it.
    const quote = 'aaaaaaaaa "bbbbbbbbb" \u201Cccccccccc\u201D ddddddddd\n  eeeeeeeee fffffffff ggggggggg hhhhhhhhh iiiiiiii, jjjjjjjjj';
    expect(preset(even, "b", [{ quote, mode: "highlight" }])).toBe(
      'Of everything here, you kept this: "aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd eeeeeeeee fffffffff ggggggggg hhhhhhhhh iiiiiiii...". ' +
        "The next one runs about 5 minutes.",
    );
  });

  // 500, 4000, 4000, 1500 make 10000 words. b ties c for longest.
  const tied = [section("a", 500), section("b", 4000), section("c", 4000), section("d", 1500)];

  it("should name the largest milestone a chapter crossed, and not call a tied chapter the longest", () => {
    // b runs from 500 to 4500: over a quarter (2500) and a third (3333), short of a half (5000). 4000 words is 22 minutes.
    expect(preset(tied, "b")).toBe("A third of the book is behind you. The next one runs about 22 minutes.");
  });

  it("should call the last of the longest chapters the longest", () => {
    expect(preset(tied, "c")).toBe("That was the longest chapter in the book; nothing ahead is longer. One chapter left: d, about 8 minutes.");
  });

  // Front matter and back matter around six chapters of 3600, 1260, 2700, 2160, 1080 and 3600 words: 14400 in all, so
  // the marks sit at 3600, 4800, 7200, 9600 and 10800. Each chapter ends past one more of them.
  const marked = [
    section("f", 3000, "front"),
    section("c1", 3600),
    section("c2", 1260),
    section("c3", 2700),
    section("c4", 2160),
    section("c5", 1080),
    section("c6", 3600),
    section("z", 900, "back"),
  ];

  it.each([
    // 0 to 3600 reaches a quarter exactly. The next one, 1260 words, is 7 minutes and shorter than 3600.
    ["c1", "A quarter of the book is behind you. The next one is shorter, about 7 minutes."],
    // 3600 to 4860 crosses a third (4800).
    ["c2", "A third of the book is behind you. The next one runs about 15 minutes."],
    // 4860 to 7560 crosses a half (7200).
    ["c3", "More of the book is behind you than ahead of you now. The next one is shorter, about 12 minutes."],
    // 7560 to 9720 crosses two thirds (9600). The next, 1080 words, is shorter than the 3600 after it.
    ["c4", "Two thirds of the book are behind you. The next one is the shortest left, about 6 minutes."],
    // 9720 to 10800 reaches three quarters exactly.
    ["c5", "Three quarters of the book are behind you. One chapter left: c6, about 20 minutes."],
  ])("should end %s on its milestone and look at the next chapter", (id, expected) => {
    expect(preset(marked, id)).toBe(expected);
  });

  it("should give the last chapter one sentence, counted over the book's own text", () => {
    expect(preset(marked, "c6")).toBe("That makes 6 of 6 chapters.");
  });

  it("should rotate the line with the chapter's position so neighbours differ", () => {
    // 900, 900, 900, 8100 and 900 make 11700 words: no mark (a quarter is 2925) falls in the first three chapters.
    // After the third, 8100 + 900 = 9000 words remain: 50 minutes.
    const book = [section("a", 900), section("b", 900), section("c", 900), section("d", 8100), section("e", 900)];
    expect(preset(book, "a")).toBe("That makes 1 of 5 chapters. The next one runs about 5 minutes.");
    expect(preset(book, "b")).toBe("2 chapters behind you, 3 ahead. The next one runs about 5 minutes.");
    expect(preset(book, "c")).toBe("Chapter 3 is done; about 50 minutes of reading remain. The next one runs about 45 minutes.");
  });

  it.each([
    // The time left is the words of d (90) and e: under an hour in minutes, then to the half hour. 90 words is the
    // next chapter's 1 minute.
    [10530, "59 minutes of reading remain"],
    [11070, "1 hour of reading remains"],
    [16110, "1.5 hours of reading remain"],
    [19710, "2 hours of reading remain"],
  ])("should say the %i words of the last chapter, and 90 before them, as %s", (words, left) => {
    // The first two chapters are long enough that c ends beyond every mark.
    const book = [section("a", 9000), section("b", 9000), section("c", 900), section("d", 90), section("e", words)];
    expect(preset(book, "c")).toBe(`Chapter 3 is done; about ${left}. The next one is the shortest left, about 1 minute.`);
  });

  it("should name no chapter number in a book that numbers its own titles, as the line above each title does not", () => {
    // A short preface first would make "Chapter 3" follow "CHAPTER II.". Words 100 + 900 + 900 + 8100 + 900 + 900 make
    // 11800, and the marks all fall inside III, the longest. After I, 10800 words (60 minutes) are ahead; after II, 9900.
    const book = [
      section("p", 100, "body", "PREFACE"),
      section("i", 900, "body", "CHAPTER I. ONE"),
      section("ii", 900, "body", "CHAPTER II. TWO"),
      section("iii", 8100, "body", "CHAPTER III. THREE"),
      section("iv", 900, "body", "CHAPTER IV. FOUR"),
      section("v", 900, "body", "CHAPTER V. FIVE"),
    ];
    expect(preset(book, "i")).toBe("About 1 hour of reading remains. The next one runs about 5 minutes.");
    expect(preset(book, "ii")).toBe("3 chapters ahead, about 55 minutes of reading in all. The next one runs about 45 minutes.");
    // The one before the last says only what is left; the last says it was the last.
    expect(preset(book, "iv")).toBe("One chapter left: Five, about 5 minutes.");
    expect(preset(book, "v")).toBe("That was the last chapter.");
  });

  it("should only count on the chapter before the last, whose second sentence already says what is left", () => {
    const book = [section("a", 9000), section("b", 9000), section("c", 900), section("d", 900)];
    expect(preset(book, "c")).toBe("That makes 3 of 4 chapters. One chapter left: d, about 5 minutes.");
  });

  it.each([
    ["CHAPTER XV. THE VALUE OF PHILOSOPHY", "The Value of Philosophy"],
    ["CHAPTER XIII. KNOWLEDGE, ERROR, AND PROBABLE OPINION", "Knowledge, Error, and Probable Opinion"],
    ["CHAPTER 7: ON INDUCTION", "On Induction"],
    ["Chapter 3: a quiet start", "a quiet start"],
  ])("should show the title %s as %s", (title, shown) => {
    // 1000 of 2800 words: a quarter (700) and a third (933) are behind, a half (1400) is not. 1800 words is 10 minutes.
    const book = [section("a", 1000), section("last", 1800, "body", title)];
    expect(preset(book, "a")).toBe(`A third of the book is behind you. One chapter left: ${shown}, about 10 minutes.`);
  });
});
