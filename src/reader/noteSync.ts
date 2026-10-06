// Keeps a book's notes in step with DeepRead, which keeps them with the book so they outlive this browser and follow
// the reader to another device. Only the request is kept: the server caches the answers.
// Each change is sent on its own (shared/notes.ts), so notes added on another device in the meantime stay. A change
// DeepRead has not taken yet waits in this browser's outbox, and goes with the next change or the next load.
import { applyNoteChange } from "../../shared/notes.ts";
import type { NoteChange } from "../../shared/notes.ts";
import type { LangCode, Note } from "../../shared/types.ts";
import { ApiFailure, api } from "../api.ts";

export type NoteSyncOptions = {
  bookId: string;
  /** The language for notes saved before each one kept its own: they were shown in the current one. */
  lang: LangCode;
  /** Called with the notes as the reader should see them, whenever that changes. */
  onChange: (notes: Note[]) => void;
  api?: Pick<typeof api, "changeNote" | "getNotes">;
  /** This browser's localStorage when not given. */
  storage?: Storage | null;
};

export type NoteSync = {
  /** The notes as the reader sees them: those DeepRead has, with the changes still on their way. */
  current(): Note[];
  /** Shows the change at once and sends it. Resolves once DeepRead took it, refused it, or could not be reached. */
  change(change: NoteChange): Promise<void>;
  /** Sends what waits from before, then loads the book's notes. */
  load(): Promise<void>;
  /** The page has moved on: nothing more is reported or sent. */
  close(): void;
};

const outboxKey = (bookId: string) => `deepread.pendingNotes.${bookId}`;
// Where this browser kept the notes before they were kept with the book: per book, and before that per chapter.
const oldKey = (bookId: string) => `deepread.notes.${bookId}`;

/** localStorage, or null where the browser refuses it (blocked site data, some private windows). */
function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function oldKeys(storage: Storage, bookId: string): string[] {
  const key = oldKey(bookId);
  const keys: string[] = [];
  for (let at = 0; at < storage.length; at += 1) {
    const name = storage.key(at);
    if (name === key || name?.startsWith(`${key}.`)) keys.push(name);
  }
  return keys;
}

/** Clears what this browser holds of a removed book's notes. */
export function forgetHeldNotes(bookId: string, storage = browserStorage()): void {
  try {
    if (storage) for (const key of [outboxKey(bookId), ...oldKeys(storage, bookId)]) storage.removeItem(key);
  } catch (error) {
    // The book is already gone; notes that could not be cleared are only wasted space.
    console.warn("could not remove the notes of a deleted book:", error);
  }
}

export function createNoteSync(options: NoteSyncOptions): NoteSync {
  const { bookId, lang, onChange } = options;
  const server = options.api ?? api;
  const storage = options.storage === undefined ? browserStorage() : options.storage;

  // The notes DeepRead has (none until they load), and the changes it has not taken yet.
  let kept: Note[] = [];
  let outbox = readOutbox();
  // Sends and the load run one after another, so changes reach DeepRead in the order they were made.
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  /** The changes waiting from before, notes this browser kept before they were kept with the book among them. */
  function readOutbox(): NoteChange[] {
    if (!storage) return [];
    try {
      const old = oldKeys(storage, bookId).flatMap((key) => {
        const saved = JSON.parse(storage.getItem(key) ?? "[]") as Note[];
        const chapterId = key.slice(oldKey(bookId).length + 1);
        return chapterId ? saved.map((note) => ({ ...note, chapterId })) : saved;
      });
      const adopted = old.map((note): NoteChange => ({ kind: "put", note: note.lang ? note : { ...note, lang }, before: null }));
      return [...adopted, ...(JSON.parse(storage.getItem(outboxKey(bookId)) ?? "[]") as NoteChange[])];
    } catch {
      return [];
    }
  }

  function writeOutbox(): void {
    if (!storage) return;
    try {
      if (outbox.length > 0) storage.setItem(outboxKey(bookId), JSON.stringify(outbox));
      else storage.removeItem(outboxKey(bookId));
      // Only once the outbox holds them (or they are sent) do the old notes give up their keys.
      for (const key of oldKeys(storage, bookId)) storage.removeItem(key);
    } catch {
      // Storage full or unavailable: changes are still sent while the page is open.
    }
  }

  const current = (): Note[] => outbox.reduce(applyNoteChange, kept);

  function report(): void {
    if (!closed) onChange(current());
  }

  /** Sends the waiting changes in order, and stops at one DeepRead cannot take now: it waits for the next try. */
  async function send(): Promise<void> {
    while (outbox.length > 0 && !closed) {
      const change = outbox[0]!;
      try {
        await server.changeNote(bookId, change);
        kept = applyNoteChange(kept, change);
      } catch (error) {
        // DeepRead answered that it never will (the book is gone, or the note is not one): dropped, not retried.
        const refused = error instanceof ApiFailure && error.status >= 400 && error.status < 500;
        if (!refused) return;
      }
      outbox = outbox.slice(1);
      writeOutbox();
    }
    report();
  }

  function queued(work: () => Promise<void>): Promise<void> {
    queue = queue.then(work);
    return queue;
  }

  return {
    current,

    change(change) {
      outbox = [...outbox, change];
      writeOutbox();
      report();
      return queued(send);
    },

    load() {
      // Notes this browser kept before are in the outbox now: their old keys can go.
      writeOutbox();
      report();
      return queued(async () => {
        await send();
        try {
          kept = await server.getNotes(bookId);
          report();
        } catch {
          // DeepRead cannot be reached: the reader sees the changes this browser holds, and they go when it can.
        }
      });
    },

    close() {
      closed = true;
    },
  };
}
