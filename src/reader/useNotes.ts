import { useCallback, useState } from "react";
import type { LangCode } from "../../shared/types.ts";
import type { Note } from "./NoteCard.tsx";

export type Notes = {
  notes: Note[];
  /** Adds a note in the current language; asking the same thing about the same text again replaces the old one. */
  addNote: (note: Omit<Note, "id" | "lang">) => void;
  /** Removes a note. It can be put back with `restoreNote` until another is removed or `forgetRemoved` is called. */
  removeNote: (id: string) => void;
  /** The note removed last, while it can still be put back. */
  removed: Note | null;
  restoreNote: () => void;
  forgetRemoved: () => void;
};

/** Whether two notes ask the same thing about the same text: a newer one replaces the older. */
function sameQuestion(a: Omit<Note, "id" | "lang">, b: Omit<Note, "id" | "lang">): boolean {
  return a.blockId === b.blockId && a.quote === b.quote && a.mode === b.mode;
}

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

// Notes saved before each one kept its language were shown in the current one, so they keep that.
function loadNotes(bookId: string, lang: LangCode): Note[] {
  try {
    const saved = localStorage.getItem(notesKey(bookId));
    const notes = saved === null ? adoptChapterNotes(bookId) : (JSON.parse(saved) as Note[]);
    return notes.map((note) => (note.lang ? note : { ...note, lang }));
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

/** The reader's notes for the whole book, loaded once and kept in this browser. New questions are asked in `lang`. */
export function useNotes(bookId: string, lang: LangCode): Notes {
  const [notes, setNotes] = useState(() => loadNotes(bookId, lang));

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
    (note: Omit<Note, "id" | "lang">) =>
      change((all) => [...all.filter((old) => !sameQuestion(old, note)), { ...note, lang, id: crypto.randomUUID() }]),
    [change, lang],
  );

  const [removed, setRemoved] = useState<{ note: Note; index: number } | null>(null);

  const removeNote = useCallback(
    (id: string) => {
      const index = notes.findIndex((note) => note.id === id);
      if (index === -1) return;
      setRemoved({ note: notes[index]!, index });
      change((all) => all.filter((note) => note.id !== id));
    },
    [notes, change],
  );

  const restoreNote = useCallback(() => {
    if (!removed) return;
    setRemoved(null);
    // Back in its old place, so it shows where it was beside its paragraph. The same question asked again since gives way.
    change((all) => {
      const rest = all.filter((note) => !sameQuestion(note, removed.note));
      return [...rest.slice(0, removed.index), removed.note, ...rest.slice(removed.index)];
    });
  }, [removed, change]);

  const forgetRemoved = useCallback(() => setRemoved(null), []);

  return { notes, addNote, removeNote, removed: removed?.note ?? null, restoreNote, forgetRemoved };
}
