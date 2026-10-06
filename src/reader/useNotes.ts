import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { sameQuestion } from "../../shared/notes.ts";
import type { NoteChange } from "../../shared/notes.ts";
import type { LangCode, Note } from "../../shared/types.ts";
import { createNoteSync } from "./noteSync.ts";
import type { NoteSync } from "./noteSync.ts";

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

/** The reader's notes for the whole book, kept with the book (see noteSync.ts). New questions are asked in `lang`. */
export function useNotes(bookId: string, lang: LangCode): Notes {
  const [notes, setNotes] = useState<Note[]>([]);
  const sync = useRef<NoteSync | null>(null);
  const langNow = useEffectEvent(() => lang);

  useEffect(() => {
    const opened = createNoteSync({ bookId, lang: langNow(), onChange: setNotes });
    sync.current = opened;
    void opened.load();
    return () => opened.close();
  }, [bookId]);

  const change = useCallback((next: NoteChange) => void sync.current?.change(next), []);

  const addNote = useCallback(
    (note: Omit<Note, "id" | "lang">) => change({ kind: "put", note: { ...note, lang, id: crypto.randomUUID() }, before: null }),
    [change, lang],
  );

  const [removed, setRemoved] = useState<{ note: Note; index: number } | null>(null);

  const removeNote = useCallback(
    (id: string) => {
      const all = sync.current?.current() ?? [];
      const index = all.findIndex((note) => note.id === id);
      if (index === -1) return;
      setRemoved({ note: all[index]!, index });
      change({ kind: "remove", id });
    },
    [change],
  );

  const restoreNote = useCallback(() => {
    if (!removed) return;
    setRemoved(null);
    // Back in its old place, so it shows where it was beside its paragraph. The same question asked again since gives way.
    const rest = (sync.current?.current() ?? []).filter((note) => !sameQuestion(note, removed.note));
    change({ kind: "put", note: removed.note, before: rest[removed.index]?.id ?? null });
  }, [removed, change]);

  const forgetRemoved = useCallback(() => setRemoved(null), []);

  return { notes, addNote, removeNote, removed: removed?.note ?? null, restoreNote, forgetRemoved };
}
