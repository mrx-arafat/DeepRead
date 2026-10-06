import { describe, expect, it } from "vitest";
import { applyNoteChange } from "../../shared/notes.ts";
import type { NoteChange } from "../../shared/notes.ts";
import type { Note } from "../../shared/types.ts";
import { ApiFailure } from "../api.ts";
import { createNoteSync } from "./noteSync.ts";

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
    sent: [] as NoteChange[],
    api: {
      changeNote: async (_bookId: string, change: NoteChange) => {
        if (!server.reachable) throw new ApiFailure("unreachable", "DeepRead is not reachable.", 0);
        if (!server.exists) throw new ApiFailure("book_not_found", "That book is not in your library.", 404);
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

    const sync = createNoteSync({ bookId: "book", lang: "hi", api: server.api, storage, onChange: () => {} });
    await sync.load();

    expect(server.notes).toEqual([note("kept"), { ...note("old"), lang: "hi" }, { ...note("older"), chapterId: "c2" }]);
    expect(sync.current()).toEqual(server.notes);
    expect([...Array(storage.length).keys()].map((at) => storage.key(at))).toEqual(["deepread.notes.other"]);
  });

  it("should show a change at once, keep it while DeepRead cannot be reached, and send it after a reload", async () => {
    const server = fakeServer([note("a"), note("b")]);
    const storage = memoryStorage();
    const seen: Note[][] = [];
    const first = createNoteSync({ bookId: "book", lang: "bn", api: server.api, storage, onChange: (notes: Note[]) => seen.push(notes) });
    await first.load();

    server.reachable = false;
    const removing = first.change({ kind: "remove", id: "b" });
    expect(seen.at(-1)).toEqual([note("a")]);
    await Promise.all([removing, first.change({ kind: "put", note: note("c"), before: null })]);
    expect(server.notes).toEqual([note("a"), note("b")]);
    first.close();

    // Reopened once DeepRead is back: the removal is not undone, and the changes arrive in the order they were made.
    server.reachable = true;
    const second = createNoteSync({ bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await second.load();
    expect(server.sent).toEqual([{ kind: "remove", id: "b" }, { kind: "put", note: note("c"), before: null }]);
    expect(server.notes).toEqual([note("a"), note("c")]);
    expect(second.current()).toEqual([note("a"), note("c")]);
    expect(storage.length).toBe(0);
  });

  it("should drop a change DeepRead refuses rather than send it forever", async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const sync = createNoteSync({ bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.load();

    server.exists = false;
    await sync.change({ kind: "put", note: note("late"), before: null });
    expect(storage.length).toBe(0);
    expect(sync.current()).toEqual([]);
  });
});
