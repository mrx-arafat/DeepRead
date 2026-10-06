import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { isHighlight, isQuestion, sameQuestion } from "../../shared/notes.ts";
import type { NoteChange } from "../../shared/notes.ts";
import type { HighlightNote, LangCode, Note, QuestionNote } from "../../shared/types.ts";
import { useSession } from "../profiles/session.tsx";
import { createNoteSync, noteOwner } from "./noteSync.ts";
import type { NoteSync } from "./noteSync.ts";

export type Notes = {
  /** The questions, each shown as a card beside its passage. */
  notes: QuestionNote[];
  /** The passages the reader highlighted, each painted in its colour. Never a card, never sent to the AI. */
  highlights: HighlightNote[];
  /** Adds a note in the current language; asking the same thing about the same text again replaces the old one. */
  addNote: (note: Omit<QuestionNote, "id" | "lang">) => void;
  /** Highlights a passage; highlighting the same words again replaces the old highlight, which is how its colour changes. */
  addHighlight: (highlight: Omit<HighlightNote, "id" | "lang" | "mode">) => void;
  /** Removes a note or a highlight. It can be put back with `restoreNote` until another is removed or `forgetRemoved` is called. */
  removeNote: (id: string) => void;
  /** The note or highlight removed last, while it can still be put back. */
  removed: Note | null;
  restoreNote: () => void;
  forgetRemoved: () => void;
};

/** The reader's notes for the whole book, kept with the book (see noteSync.ts). New questions are asked in `lang`. */
export function useNotes(bookId: string, lang: LangCode): Notes {
  const [all, setAll] = useState<Note[]>([]);
  const sync = useRef<NoteSync | null>(null);
  const langNow = useEffectEvent(() => lang);
  // What this browser keeps for the book is filed under who is reading, so another profile's unsent notes stay out of it.
  const { profileId, inheritsOldNotes } = noteOwner(useSession().info);

  useEffect(() => {
    const opened = createNoteSync({ bookId, profileId, inheritsOldNotes, lang: langNow(), onChange: setAll });
    sync.current = opened;
    void opened.load();
    return () => opened.close();
  }, [bookId, profileId, inheritsOldNotes]);

  // Kept apart, so a highlight never shows as a card nor changes which card is the newest. A note of a kind this
  // version does not know (kept by a newer DeepRead on another device) is neither, and is left as it is.
  const notes = useMemo(() => all.filter(isQuestion), [all]);
  const highlights = useMemo(() => all.filter(isHighlight), [all]);

  const change = useCallback((next: NoteChange) => void sync.current?.change(next), []);

  const addNote = useCallback(
    (note: Omit<QuestionNote, "id" | "lang">) => change({ kind: "put", note: { ...note, lang, id: crypto.randomUUID() }, before: null }),
    [change, lang],
  );

  const addHighlight = useCallback(
    (highlight: Omit<HighlightNote, "id" | "lang" | "mode">) =>
      change({ kind: "put", note: { ...highlight, mode: "highlight", lang, id: crypto.randomUUID() }, before: null }),
    [change, lang],
  );

  const [removed, setRemoved] = useState<{ note: Note; index: number } | null>(null);

  const removeNote = useCallback(
    (id: string) => {
      const now = sync.current?.current() ?? [];
      const index = now.findIndex((note) => note.id === id);
      if (index === -1) return;
      setRemoved({ note: now[index]!, index });
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

  return { notes, highlights, addNote, addHighlight, removeNote, removed: removed?.note ?? null, restoreNote, forgetRemoved };
}
