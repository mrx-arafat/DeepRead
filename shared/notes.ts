// How one change to a book's notes is applied. The reader shows a change at once and DeepRead keeps it, each
// applying it with this same function, so what the reader sees is what is kept. Changes go one at a time, never as
// a whole list, so notes added on another device in the meantime stay.
import type { Note } from "./types.ts";

export type NoteChange =
  /**
   * Adds `note`, or puts a removed one back, before the note `before` (at the end when that is not there).
   * It replaces a note with the same id, and one asking the same thing about the same text.
   */
  | { kind: "put"; note: Note; before: string | null }
  | { kind: "remove"; id: string };

/** Whether two notes ask the same thing about the same text: a newer one replaces the older. */
export function sameQuestion(a: Pick<Note, "blockId" | "quote" | "mode">, b: Pick<Note, "blockId" | "quote" | "mode">): boolean {
  return a.blockId === b.blockId && a.quote === b.quote && a.mode === b.mode;
}

export function applyNoteChange(notes: Note[], change: NoteChange): Note[] {
  if (change.kind === "remove") return notes.filter((note) => note.id !== change.id);
  const { note, before } = change;
  const rest = notes.filter((old) => old.id !== note.id && !sameQuestion(old, note));
  const at = before === null ? -1 : rest.findIndex((old) => old.id === before);
  return at === -1 ? [...rest, note] : [...rest.slice(0, at), note, ...rest.slice(at)];
}
