// How one change to a book's notes is applied. The reader shows a change at once and DeepRead keeps it, each
// applying it with this same function, so what the reader sees is what is kept. Changes go one at a time, never as
// a whole list, so notes added on another device in the meantime stay.
import { isHighlightColor } from "./types.ts";
import type { ExplainMode, HighlightNote, Note, QuestionNote } from "./types.ts";

export type NoteChange =
  /**
   * Adds `note`, or puts a removed one back, before the note `before` (at the end when that is not there).
   * It replaces a note with the same id, and one asking the same thing about the same text.
   */
  | { kind: "put"; note: Note; before: string | null }
  | { kind: "remove"; id: string };

/** What tells two notes apart: the words, where they are, and what was done with them. */
type NoteKey = Pick<Note, "blockId" | "quote" | "mode"> & { offset?: number };

/**
 * Whether two notes ask the same thing about the same text, or highlight the same words: a newer one replaces the older.
 * Highlighting the same words again is also how a highlight changes colour.
 */
export function sameQuestion(a: NoteKey, b: NoteKey): boolean {
  return a.blockId === b.blockId && a.quote === b.quote && a.mode === b.mode && a.offset === b.offset;
}

// A Record makes this list exhaustive: a new kind of question fails to compile until it is added here.
const QUESTION_MODES: Record<ExplainMode, true> = { word: true, simple: true, example: true, native: true };

/** A question, shown as a card. A note of a kind this version does not know (kept by a newer DeepRead) is neither. */
export function isQuestion(note: Note): note is QuestionNote {
  return Object.hasOwn(QUESTION_MODES, note.mode);
}

/** A highlight this version can paint. */
export function isHighlight(note: Note): note is HighlightNote {
  return note.mode === "highlight" && isHighlightColor(note.color) && Number.isInteger(note.offset);
}

export function applyNoteChange(notes: Note[], change: NoteChange): Note[] {
  if (change.kind === "remove") return notes.filter((note) => note.id !== change.id);
  const { note, before } = change;
  const rest = notes.filter((old) => old.id !== note.id && !sameQuestion(old, note));
  const at = before === null ? -1 : rest.findIndex((old) => old.id === before);
  return at === -1 ? [...rest, note] : [...rest.slice(0, at), note, ...rest.slice(at)];
}
