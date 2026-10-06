import { describe, expect, it } from "vitest";
import { applyNoteChange } from "../../shared/notes.ts";
import type { NoteChange } from "../../shared/notes.ts";
import type { Note } from "../../shared/types.ts";
import { ApiFailure } from "../api.ts";
import { createNoteSync, forgetHeldNotes } from "./noteSync.ts";

/** localStorage, kept in a Map. */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

/** DeepRead's notes for one book, reachable or not. */
function fakeServer(notes: Note[] = []) {
  const server = {
    notes,
    reachable: true,
    exists: true,
    /** An HTTP status DeepRead answers every change with, until set back to null. */
    answers: null as number | null,
    sent: [] as NoteChange[],
    api: {
      changeNote: async (_bookId: string, change: NoteChange) => {
        if (!server.reachable) throw new ApiFailure("unreachable", "DeepRead is not reachable.", 0);
        if (!server.exists) throw new ApiFailure("book_not_found", "That book is not in your library.", 404);
        if (server.answers) throw new ApiFailure("refused", "DeepRead did not take it.", server.answers);
        server.sent.push(change);
        server.notes = applyNoteChange(server.notes, change);
      },
      getNotes: async () => {
        if (!server.reachable) throw new ApiFailure("unreachable", "DeepRead is not reachable.", 0);
        return server.notes;
      },
    },
  };
  return server;
}

/** No profiles: one library, and the notes this browser kept before belong to it. */
const single = { profileId: null, inheritsOldNotes: true };
const profile = (profileId: string, admin = false) => ({ profileId, inheritsOldNotes: admin });

const note = (id: string, blockId = `b-${id}`): Note => ({ id, chapterId: "c1", blockId, quote: id, mode: "word", lang: "bn" });

describe("createNoteSync", () => {
  it("should move notes this browser kept before into the book's, and forget its own copy only once DeepRead has them", async () => {
    const server = fakeServer([note("kept")]);
    const { lang: _lang, ...withoutLang } = note("old");
    const { chapterId: _chapter, ...perChapter } = note("older");
    const storage = memoryStorage({
      "deepread.notes.book": JSON.stringify([withoutLang]),
      "deepread.notes.book.c2": JSON.stringify([perChapter]),
      "deepread.notes.other": JSON.stringify([note("another book")]),
    });

    const sync = createNoteSync({ ...single, bookId: "book", lang: "hi", api: server.api, storage, onChange: () => {} });
    await sync.load();

    expect(server.notes).toEqual([note("kept"), { ...note("old"), lang: "hi" }, { ...note("older"), chapterId: "c2" }]);
    expect(sync.current()).toEqual(server.notes);
    expect([...Array(storage.length).keys()].map((at) => storage.key(at))).toEqual(["deepread.notes.other"]);
  });

  it("should show a change at once, keep it while DeepRead cannot be reached, and send it after a reload", async () => {
    const server = fakeServer([note("a"), note("b")]);
    const storage = memoryStorage();
    const seen: Note[][] = [];
    const first = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: (notes: Note[]) => seen.push(notes) });
    await first.load();

    server.reachable = false;
    const removing = first.change({ kind: "remove", id: "b" });
    expect(seen.at(-1)).toEqual([note("a")]);
    await Promise.all([removing, first.change({ kind: "put", note: note("c"), before: null })]);
    expect(server.notes).toEqual([note("a"), note("b")]);
    first.close();

    // Reopened once DeepRead is back: the removal is not undone, and the changes arrive in the order they were made.
    server.reachable = true;
    const second = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await second.load();
    expect(server.sent).toEqual([{ kind: "remove", id: "b" }, { kind: "put", note: note("c"), before: null }]);
    expect(server.notes).toEqual([note("a"), note("c")]);
    expect(second.current()).toEqual([note("a"), note("c")]);
    expect(storage.length).toBe(0);
  });

  it("should drop a change DeepRead refuses rather than send it forever", async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.load();

    server.exists = false;
    await sync.change({ kind: "put", note: note("late"), before: null });
    expect(storage.length).toBe(0);
    expect(sync.current()).toEqual([]);
  });

  it("should keep a profile's unsent notes out of every other profile's library", async () => {
    const server = fakeServer();
    const change: NoteChange = { kind: "put", note: note("ann's"), before: null };
    const storage = memoryStorage({ "deepread.pendingNotes.ann.book": JSON.stringify([change]) });

    // Same PDF, so the same book id, but Bob's library is not Ann's.
    const bob = createNoteSync({ ...profile("bob"), bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await bob.load();
    expect(server.sent).toEqual([]);
    expect(bob.current()).toEqual([]);
    expect(storage.getItem("deepread.pendingNotes.ann.book")).toBe(JSON.stringify([change]));

    const ann = createNoteSync({ ...profile("ann"), bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await ann.load();
    expect(server.sent).toEqual([change]);
    expect(storage.length).toBe(0);
  });

  it("should hand the notes from before profiles to the single library or the admin, and to no one else", async () => {
    const old = { kind: "put", note: note("from the old outbox"), before: null } satisfies NoteChange;
    const entries = {
      "deepread.notes.book": JSON.stringify([note("legacy")]),
      "deepread.pendingNotes.book": JSON.stringify([old]),
    };

    for (const [owner, adopts] of [
      [single, true],
      [profile("root", true), true],
      [profile("bob"), false],
    ] as const) {
      const server = fakeServer();
      const storage = memoryStorage(entries);
      const sync = createNoteSync({ ...owner, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
      await sync.load();

      expect(server.notes, String(owner.profileId)).toEqual(adopts ? [note("legacy"), note("from the old outbox")] : []);
      expect(storage.length, String(owner.profileId)).toBe(adopts ? 0 : 2);
    }
  });

  it("should forget only the notes a profile is allowed to hold when its book is removed", () => {
    const entries = {
      "deepread.notes.book": "[]",
      "deepread.pendingNotes.book": "[]",
      "deepread.pendingNotes.ann.book": "[]",
      "deepread.pendingNotes.bob.book": "[]",
    };
    const bobs = memoryStorage(entries);
    forgetHeldNotes("book", profile("bob"), bobs);
    expect([...Array(bobs.length).keys()].map((at) => bobs.key(at)).sort()).toEqual([
      "deepread.notes.book",
      "deepread.pendingNotes.ann.book",
      "deepread.pendingNotes.book",
    ]);

    const admins = memoryStorage(entries);
    forgetHeldNotes("book", profile("ann", true), admins);
    expect([...Array(admins.length).keys()].map((at) => admins.key(at))).toEqual(["deepread.pendingNotes.bob.book"]);
  });

  it.each([401, 408, 429])("should keep a change DeepRead answers %i to, and send it on the next try", async (status) => {
    const server = fakeServer();
    const storage = memoryStorage();
    const owner = profile("ann");
    const first = createNoteSync({ ...owner, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await first.load();

    // A note made just as the session ends, or while DeepRead asks to slow down, is not a note DeepRead refused for good.
    server.answers = status;
    await first.change({ kind: "put", note: note("late"), before: null });
    expect(first.current()).toEqual([note("late")]);
    expect(storage.getItem("deepread.pendingNotes.ann.book")).not.toBeNull();
    first.close();

    server.answers = null;
    const second = createNoteSync({ ...owner, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await second.load();
    expect(server.notes).toEqual([note("late")]);
    expect(storage.length).toBe(0);
  });
});
