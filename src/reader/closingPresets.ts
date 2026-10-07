// The quiet line at the end of a chapter when no AI writes one. It says only what the book and the reader's own marks
// show, so it can be checked: no praise, no grade, no score. The first sentence looks back, the second looks ahead.

import type { ChapterSummary, ExplainMode } from "../../shared/types.ts";
import { chapterPosition, kindOf, minutes } from "./book.ts";

export type ClosingFacts = {
  /** Every chapter of the book in order, as BookDetail.chapters gives them (id, title, kind, wordCount, ...). */
  chapters: ChapterSummary[];
  /** The chapter the reader just finished. */
  chapterId: string;
  /** The reader's own notes in that chapter, in reading order: highlights and questions. */
  marks: { quote: string; mode: "highlight" | ExplainMode }[];
};

// The same floor as the preview and recap in ChapterSection: a shorter chapter is read in a moment.
const MIN_WORDS = 500;

// Long enough to recognise a passage, short enough for one quiet line.
const QUOTE_MAX = 90;

// For a count of two to ten; more is written in digits.
const COUNT_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

// Lower case inside a title, unless first.
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);

// Smallest first: a chapter that crosses several is told about the largest.
const MILESTONES: [number, number, string][] = [
  [1, 4, "A quarter of the book is behind you."],
  [1, 3, "A third of the book is behind you."],
  [1, 2, "More of the book is behind you than ahead of you now."],
  [2, 3, "Two thirds of the book are behind you."],
  [3, 4, "Three quarters of the book are behind you."],
];

// "CHAPTER XV. " or "Chapter 3: ". The mark after the number keeps a word made of numeral letters ("Mix") safe.
const CHAPTER_PREFIX = /^chapter\s+(?:\d+|[ivxlcdm]+)\s*[.:]\s*/i;

const wordsIn = (chapters: ChapterSummary[]): number => chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

const minutesText = (count: number): string => (count === 1 ? "1 minute" : `${count} minutes`);

/** Reading time left: minutes under an hour, then hours to the nearest half. */
function timeText(words: number): string {
  const count = minutes(words);
  if (count < 60) return minutesText(count);
  const hours = Math.round(count / 30) / 2;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** A passage as it sits inside our own quotation marks: one line, no marks of its own, cut at a word. */
function quoted(text: string): string {
  const clean = text
    .replace(/["\u201C\u201D\u201E\u00AB\u00BB]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^['\u2018\u2019]+|['\u2018\u2019]+$/g, "");
  if (clean.length <= QUOTE_MAX) return clean;
  // One character past the limit shows whether the cut lands exactly between two words.
  const head = clean.slice(0, QUOTE_MAX + 1);
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 0 ? space : QUOTE_MAX).replace(/[\s,;:]+$/, "")}...`;
}

/** A title as it reads inside a sentence: no "CHAPTER XV." in front, and capitals only where a title has them. */
function plainTitle(title: string): string {
  const full = title.trim().replace(/\s+/g, " ");
  const rest = full.replace(CHAPTER_PREFIX, "");
  if (!rest) return full;
  // A title written in mixed case was meant that way.
  if (rest !== rest.toUpperCase()) return rest;
  return rest
    .toLowerCase()
    .split(" ")
    .map((word, at) => (at > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function lookBack(main: ChapterSummary[], chapter: ChapterSummary, marks: ClosingFacts["marks"], numbered: boolean): string | null {
  const at = main.indexOf(chapter);
  const highlights = marks.filter((mark) => mark.mode === "highlight");
  const [kept] = highlights;
  if (kept) {
    if (highlights.length === 1) return `Of everything here, you kept this: "${kept.quote}".`;
    const count = COUNT_WORDS[highlights.length - 2] ?? highlights.length;
    return `You kept ${count} passages from this chapter. The first: "${kept.quote}".`;
  }
  // No highlight, so every mark left is a question.
  const [asked] = marks;
  if (asked) return `Your question about "${asked.quote}" stays in the margin, beside its passage.`;

  const ahead = main.slice(at + 1);
  // Nothing is ahead of the last chapter, so only the count says anything true about it.
  if (ahead.length > 0) {
    const longest = Math.max(...main.map((item) => item.wordCount));
    if (chapter.wordCount === longest && ahead.every((item) => item.wordCount < longest)) {
      return "That was the longest chapter in the book; nothing ahead is longer.";
    }
    // Compared as fractions of the whole, in whole numbers, so a chapter ending exactly on a mark counts.
    const total = wordsIn(main);
    const before = wordsIn(main.slice(0, at));
    const after = before + chapter.wordCount;
    const crossed = MILESTONES.findLast(([top, bottom]) => before * bottom < top * total && after * bottom >= top * total);
    if (crossed) return crossed[2];
  }

  const left = timeText(wordsIn(ahead));
  const remain = left.startsWith("1 ") ? "remains" : "remain";
  // A book that numbers its own titles would hear "Chapter 3" after "CHAPTER II." when a preface comes first, so it is
  // told what is ahead, which no numbering can contradict. The same rule hides the count above each title.
  if (numbered) {
    if (ahead.length === 0) return "That was the last chapter.";
    // The one before the last hears "One chapter left" next, which already says what remains.
    if (ahead.length === 1) return null;
    return at % 2 === 0 ? `${ahead.length} chapters ahead, about ${left} of reading in all.` : `About ${left} of reading ${remain}.`;
  }

  const done = at + 1;
  // The last chapter has nothing ahead or remaining, and the one before it hears "One chapter left" next, so for both
  // only the count adds something.
  const shape = ahead.length <= 1 ? 0 : at % 3;
  if (shape === 0) return `That makes ${done} of ${main.length} chapters.`;
  if (shape === 1) return `${done} chapters behind you, ${main.length - done} ahead.`;
  return `Chapter ${done} is done; about ${left} of reading ${remain}.`;
}

function lookForward(chapter: ChapterSummary, next: ChapterSummary, ahead: ChapterSummary[]): string {
  const time = minutesText(minutes(next.wordCount));
  if (ahead.length === 1) return `One chapter left: ${plainTitle(next.title)}, about ${time}.`;
  if (ahead.slice(1).every((item) => item.wordCount > next.wordCount)) return `The next one is the shortest left, about ${time}.`;
  if (next.wordCount < chapter.wordCount) return `The next one is shorter, about ${time}.`;
  return `The next one runs about ${time}.`;
}

/** One or two plain sentences for the end of the chapter, or null when the chapter gets none. */
export function closingPreset(facts: ClosingFacts): string | null {
  const main = facts.chapters.filter((chapter) => kindOf(chapter) === "body");
  const at = main.findIndex((chapter) => chapter.id === facts.chapterId);
  const chapter = main[at];
  // A book of one chapter has no count, milestone or longest to tell.
  if (!chapter || chapter.wordCount < MIN_WORDS || main.length < 2) return null;

  // A blank quote has nothing to show back.
  const marks = facts.marks.map((mark) => ({ mode: mark.mode, quote: quoted(mark.quote) })).filter((mark) => mark.quote);
  const back = lookBack(main, chapter, marks, chapterPosition(facts.chapters, chapter.id) === undefined);
  const ahead = main.slice(at + 1);
  const [next] = ahead;
  return [back, next && lookForward(chapter, next, ahead)].filter(Boolean).join(" ") || null;
}
