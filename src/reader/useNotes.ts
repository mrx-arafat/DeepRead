import { useCallback, useState } from "react";
import type { Note } from "./NoteCard.tsx";

export type Notes = {
  notes: Note[];
  /** Adds a note; asking the same thing about the same text again replaces the old one. */
  addNote: (note: Omit<Note, "id">) => void;
  removeNote: (id: string) => void;
};

// Notes outlive a page reload. Only the request is kept: the server caches the answers.
const notesKey = (bookId: string) => `deepread.notes.${bookId}`;

/** Notes used to be kept per chapter: gather them into the book's list once, so none are lost. */
function adoptChapterNotes(bookId: string): Note[] {
  const prefix = `${notesKey(bookId)}.`;
  const keys = Object.keys(localStorage).filter((key) => key.startsWith(prefix));
  const notes = keys.flatMap((key) => {
    const chapterId = key.slice(prefix.length);
    const old = JSON.parse(localStorage.getItem(key) ?? "[]") as Omit<Note, "chapterId">[];
    return old.map((note) => ({ ...note, chapterId }));
  });
  // Throws when storage is full; the old keys then stay for the next try.
  if (notes.length) localStorage.setItem(notesKey(bookId), JSON.stringify(notes));
  for (const key of keys) localStorage.removeItem(key);
  return notes;
}

function loadNotes(bookId: string): Note[] {
  try {
    const saved = localStorage.getItem(notesKey(bookId));
    return saved === null ? adoptChapterNotes(bookId) : (JSON.parse(saved) as Note[]);
  } catch {
    return [];
  }
}

function saveNotes(bookId: string, notes: Note[]) {
  try {
    if (notes.length) localStorage.setItem(notesKey(bookId), JSON.stringify(notes));
    else localStorage.removeItem(notesKey(bookId));
  } catch {
    // Storage unavailable: notes still work until the page is closed.
  }
}

/** The reader's notes for the whole book, loaded once and kept in this browser. */
export function useNotes(bookId: string): Notes {
  const [notes, setNotes] = useState(() => loadNotes(bookId));

  const change = useCallback(
    (update: (all: Note[]) => Note[]) =>
      setNotes((all) => {
        const next = update(all);
        saveNotes(bookId, next);
        return next;
      }),
    [bookId],
  );

  const addNote = useCallback(
    (note: Omit<Note, "id">) =>
      change((all) => [
        ...all.filter((old) => !(old.blockId === note.blockId && old.quote === note.quote && old.mode === note.mode)),
        { ...note, id: crypto.randomUUID() },
      ]),
    [change],
  );

  const removeNote = useCallback((id: string) => change((all) => all.filter((note) => note.id !== id)), [change]);

  return { notes, addNote, removeNote };
}
