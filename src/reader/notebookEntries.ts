import { LANGUAGES, type BookDetail, type Note } from "../../shared/types.ts";
import { parseSections } from "./RichText.tsx";

/** What an entry in the Notebook is: a passage marked, an AI answer kept, or the reader's own words. */
export type EntryKind = "highlight" | "answer" | "reflection";

export type ChapterGroup = { chapterId: string; title: string; entries: Note[] };

/** Highlights, reflections, and the AI answers the reader saved. An answer only looked at is not theirs to keep. */
function kept(note: Note): boolean {
  return note.mode === "highlight" || note.mode === "reflection" || Boolean(note.savedAnswer?.trim());
}

/** Where a paragraph comes in its chapter: block ids end in their number ("c2-b10"), which a plain sort puts before b2. */
function blockIndex(blockId: string): number {
  const number = /(\d+)$/.exec(blockId)?.[1];
  return number === undefined ? Number.MAX_SAFE_INTEGER : Number(number);
}

/** The kept entries, in the book's chapter order and, within a chapter, in the order their passages come in the text. */
export function keptEntries(notes: readonly Note[], chapters: BookDetail["chapters"]): Note[] {
  const chapterIndex = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  const position = (note: Note) => [chapterIndex.get(note.chapterId) ?? chapters.length, blockIndex(note.blockId), note.offset ?? 0];
  return notes.filter(kept).sort((a, b) => {
    const [ca, ba, oa] = position(a);
    const [cb, bb, ob] = position(b);
    return ca! - cb! || ba! - bb! || oa! - ob! || a.blockId.localeCompare(b.blockId);
  });
}

/** `entries` in runs of one chapter each, keeping their order. A chapter the book no longer has keeps its id as its title. */
export function groupByChapter(entries: readonly Note[], chapters: BookDetail["chapters"]): ChapterGroup[] {
  const titles = new Map(chapters.map((chapter) => [chapter.id, chapter.title]));
  const groups: ChapterGroup[] = [];
  for (const note of entries) {
    const last = groups.at(-1);
    if (last?.chapterId === note.chapterId) last.entries.push(note);
    else groups.push({ chapterId: note.chapterId, title: titles.get(note.chapterId) ?? note.chapterId, entries: [note] });
  }
  return groups;
}

export function entryKind(note: Note): EntryKind {
  return note.mode === "highlight" || note.mode === "reflection" ? note.mode : "answer";
}

/** The entry as a word in a sentence, for buttons that act on it: "Remove saved answer". */
export function entryNoun(note: Note): string {
  return { highlight: "highlight", reflection: "reflection", answer: "saved answer" }[entryKind(note)];
}

/** The entry's name, as its card in the margin was called: "Example", "In Bangla", "Reflection". */
export function entryLabel(note: Note): string {
  switch (note.mode) {
    case "highlight":
      return "Highlight";
    case "reflection":
      return "Reflection";
    case "example":
      return "Example";
    case "native":
      return `In ${LANGUAGES[note.lang]}`;
    case "word":
      return "Word meaning";
    default:
      return "Explanation";
  }
}

/** The entry's own words, as written: a reflection's text or a saved answer. A highlight has none. */
export function entryText(note: Note): string {
  return note.mode === "reflection" ? note.text : note.mode === "highlight" ? "" : (note.savedAnswer ?? "");
}

/** Bold and italic marks the AI types (**word**, *word*, _word_), without the words they wrap. */
function unmarked(text: string): string {
  return text.replace(/\*+/g, "").replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=$|[\s).,;:!?])/g, "$1$2");
}

/** One line to know an entry by in the list: an answer's first sentence of substance, or the reflection, as plain text. */
export function entryPreview(note: Note): string {
  const text = entryText(note);
  if (!text) return "";
  if (note.mode === "reflection") return text.replace(/\s+/g, " ").trim();
  const first = parseSections(text)
    .flatMap((section) => section.blocks)
    .map((block) => (block.type === "p" ? block.text : block.items.join("; ")))
    .find((line) => line.trim());
  return unmarked(first ?? text).replace(/\s+/g, " ").trim();
}
