// How one change to a book's notes is applied. The reader shows a change at once and DeepRead keeps it, each
// applying it with this same function, so what the reader sees is what is kept. Changes go one at a time, never as
// a whole list, so notes added on another device in the meantime stay.
import { isHighlightColor } from "./types.ts";
import type { ExplainMode, HighlightNote, Note, QuestionNote, ReflectionNote } from "./types.ts";

export type NoteChange =
  /**
   * Adds `note`, or puts a removed one back, before the note `before` (at the end when that is not there).
   * It replaces a note with the same id. Questions/highlights also replace a matching mark; reflections stay distinct.
   */
  | { kind: "put"; note: Note; before: string | null }
  | { kind: "remove"; id: string };

/** What tells questions and highlights apart: the words, where they are, and what was done with them. */
type NoteKey = Pick<Note, "blockId" | "quote" | "mode"> & { offset?: number };

/**
 * Whether two questions ask the same thing or two highlights mark the same words. Legacy questions have no offset, so
 * their passage matches an anchored version; two anchored occurrences stay distinct. Reflections match only by id.
 */
export function sameQuestion(a: NoteKey, b: NoteKey): boolean {
  return a.mode !== "reflection" && b.mode !== "reflection" && a.blockId === b.blockId && a.quote === b.quote && a.mode === b.mode &&
    (a.offset === b.offset || (a.mode !== "highlight" && (a.offset === undefined || b.offset === undefined)));
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

/** A reader-authored reflection, distinct even when another uses the same passage. */
export function isReflection(note: Note): note is ReflectionNote {
  return note.mode === "reflection" && Number.isInteger(note.offset) && typeof note.text === "string";
}

export function applyNoteChange(notes: Note[], change: NoteChange): Note[] {
  if (change.kind === "remove") return notes.filter((note) => note.id !== change.id);
  const { note, before } = change;
  if (isQuestion(note) && notes.some((old) => old.id !== note.id && isQuestion(old) && sameQuestion(old, note) &&
    ((old.savedAnswer !== undefined && note.savedAnswer === undefined) || (old.offset !== undefined && note.offset === undefined)))) return notes;
  const rest = notes.filter((old) => old.id !== note.id && !sameQuestion(old, note));
  const at = before === null ? -1 : rest.findIndex((old) => old.id === before);
  return at === -1 ? [...rest, note] : [...rest.slice(0, at), note, ...rest.slice(at)];
}
