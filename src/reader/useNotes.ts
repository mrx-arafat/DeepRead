import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { isHighlight, isQuestion, isReflection, sameQuestion } from "../../shared/notes.ts";
import type { NoteChange } from "../../shared/notes.ts";
import type { HighlightNote, LangCode, Note, QuestionNote, ReflectionNote } from "../../shared/types.ts";
import { useSession } from "../profiles/session.tsx";
import { createNoteSync, noteOwner } from "./noteSync.ts";
import type { NoteSync, NoteSyncState } from "./noteSync.ts";

export type Notes = {
  /** Current reader's complete notes, including entries shown in the notebook. */
  allNotes: Note[];
  /** The questions, each shown as a card beside its passage. */
  notes: QuestionNote[];
  /** The passages the reader highlighted, each painted in its colour. Never a card, never sent to the AI. */
  highlights: HighlightNote[];
  reflections: ReflectionNote[];
  /** Adds a note in the current language; asking the same thing about the same text again replaces the old one. */
  addNote: (note: Omit<QuestionNote, "id" | "lang">) => void;
  /** Highlights a passage; highlighting the same words again replaces the old highlight, which is how its colour changes. */
  addHighlight: (highlight: Omit<HighlightNote, "id" | "lang" | "mode">) => void;
  saveReflection: (draft: Pick<ReflectionNote, "chapterId" | "blockId" | "quote" | "offset">, text: string, id?: string) => void;
  saveAnswer: (note: QuestionNote, answer: string) => void;
  /** Removes a note or a highlight. It can be put back with `restoreNote` until another is removed or `forgetRemoved` is called. */
  removeNote: (id: string) => void;
  /** The note or highlight removed last, while it can still be put back. */
  removed: Note | null;
  restoreNote: () => void;
  forgetRemoved: () => void;
  syncState: NoteSyncState;
  retryNotes: () => void;
  discardRejectedNotes: () => void;
};

/** How often a page in view looks for notes added on another device. */
const REFRESH_MS = 30_000;

/** The reader's notes for the whole book, kept with the book (see noteSync.ts). New questions are asked in `lang`. */
export function useNotes(bookId: string, lang: LangCode): Notes {
  const [snapshot, setSnapshot] = useState<{ key: string; notes: Note[]; status: NoteSyncState } | null>(null);
  const sync = useRef<{ key: string; opened: NoteSync } | null>(null);
  const langNow = useEffectEvent(() => lang);
  // What this browser keeps for the book is filed under who is reading, so another profile's unsent notes stay out of it.
  const { profileId, inheritsOldNotes } = noteOwner(useSession().info);
  const key = JSON.stringify([bookId, profileId, inheritsOldNotes]);
  const all = snapshot?.key === key ? snapshot.notes : [];
  const syncState: NoteSyncState = snapshot?.key === key ? snapshot.status : { phase: "saving", pending: 0, durable: true };
  const activeSync = useCallback(() => sync.current?.key === key ? sync.current.opened : null, [key]);

  useEffect(() => {
    const opened = createNoteSync({ bookId, profileId, inheritsOldNotes, lang: langNow(),
      onChange: (notes) => setSnapshot((current) => ({ key, notes, status: current?.key === key ? current.status : { phase: "saving", pending: 0, durable: true } })),
      onStatus: (status) => setSnapshot((current) => ({ key, notes: current?.key === key ? current.notes : [], status })),
    });
    sync.current = { key, opened };
    void opened.load();
    // Notes added on another device show up without a reload: look again when the reader comes back to the page, and now
    // and then while it is in view. A hidden tab does not poll.
    const refresh = () => void opened.refresh();
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(`deepread.pendingNotes.${profileId ?? "single"}.${bookId}`)) refresh();
    };
    window.addEventListener("storage", storageChanged);
    const timer = setInterval(refreshIfVisible, REFRESH_MS);
    return () => {
      opened.close();
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("storage", storageChanged);
      clearInterval(timer);
    };
  }, [bookId, profileId, inheritsOldNotes, key]);

  // Kept apart, so a highlight never shows as a card nor changes which card is the newest. A note of a kind this
  // version does not know (kept by a newer DeepRead on another device) is neither, and is left as it is.
  const notes = useMemo(() => all.filter(isQuestion), [all]);
  const highlights = useMemo(() => all.filter(isHighlight), [all]);
  const reflections = useMemo(() => all.filter(isReflection), [all]);

  const change = useCallback((next: NoteChange) => void activeSync()?.change(next), [activeSync]);
  const retryNotes = useCallback(() => void activeSync()?.retry(), [activeSync]);
  const discardRejectedNotes = useCallback(() => void activeSync()?.discardRejected(), [activeSync]);

  const addNote = useCallback(
    (note: Omit<QuestionNote, "id" | "lang">) => change({ kind: "put", note: { ...note, lang, id: crypto.randomUUID() }, before: null }),
    [change, lang],
  );

  const addHighlight = useCallback(
    (highlight: Omit<HighlightNote, "id" | "lang" | "mode">) =>
      change({ kind: "put", note: { ...highlight, mode: "highlight", lang, id: crypto.randomUUID() }, before: null }),
    [change, lang],
  );

  const saveReflection = useCallback(
    (draft: Pick<ReflectionNote, "chapterId" | "blockId" | "quote" | "offset">, text: string, id?: string) => {
      const existing = id ? activeSync()?.current().find((note) => note.id === id && isReflection(note)) : null;
      change({ kind: "put", note: { ...draft, mode: "reflection", text, lang: existing?.lang ?? lang, id: id ?? crypto.randomUUID() }, before: null });
    },
    [activeSync, change, lang],
  );

  const saveAnswer = useCallback(
    (note: QuestionNote, savedAnswer: string) => change({ kind: "put", note: { ...note, savedAnswer }, before: null }),
    [change],
  );

  const [lastRemoved, setRemoved] = useState<{ key: string; note: Note; index: number } | null>(null);
  const removed = lastRemoved?.key === key ? lastRemoved : null;

  const removeNote = useCallback(
    (id: string) => {
      const now = activeSync()?.current() ?? [];
      const index = now.findIndex((note) => note.id === id);
      if (index === -1) return;
      setRemoved({ key, note: now[index]!, index });
      change({ kind: "remove", id });
    },
    [change, key, activeSync],
  );

  const restoreNote = useCallback(() => {
    if (!removed) return;
    setRemoved(null);
    // Back in its old place, so it shows where it was beside its paragraph. The same question asked again since gives way.
    const rest = (activeSync()?.current() ?? []).filter((note) => !sameQuestion(note, removed.note));
    change({ kind: "put", note: removed.note, before: rest[removed.index]?.id ?? null });
  }, [removed, change, activeSync]);

  const forgetRemoved = useCallback(() => setRemoved(null), []);

  return { allNotes: all, notes, highlights, reflections, addNote, addHighlight, saveReflection, saveAnswer, removeNote, removed: removed?.note ?? null, restoreNote, forgetRemoved, syncState, retryNotes, discardRejectedNotes };
}
