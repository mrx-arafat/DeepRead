import { afterEach, describe, expect, it, vi } from "vitest";
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
    /** Every request DeepRead took, in order: "change" or "read". */
    calls: [] as string[],
    /** While set, an answer to getNotes (made when asked) is held back until it settles. */
    holdReads: null as Promise<void> | null,
    api: {
      changeNote: async (_bookId: string, change: NoteChange) => {
        if (!server.reachable) throw new ApiFailure("unreachable", "DeepRead is not reachable.", 0);
        if (!server.exists) throw new ApiFailure("book_not_found", "That book is not in your library.", 404);
        if (server.answers) throw new ApiFailure("refused", "DeepRead did not take it.", server.answers);
        server.calls.push("change");
        server.sent.push(change);
        server.notes = applyNoteChange(server.notes, change);
      },
      getNotes: async () => {
        if (!server.reachable) throw new ApiFailure("unreachable", "DeepRead is not reachable.", 0);
        server.calls.push("read");
        const answer = server.notes;
        await server.holdReads;
        return answer;
      },
    },
  };
  return server;
}

/** No profiles: one library, and the notes this browser kept before belong to it. */
const single = { profileId: null, inheritsOldNotes: true };
const profile = (profileId: string, admin = false) => ({ profileId, inheritsOldNotes: admin });

const note = (id: string, blockId = `b-${id}`): Note => ({ id, chapterId: "c1", blockId, quote: id, mode: "word", lang: "bn" });

function mockBrowserLocks(): void {
  const queues = new Map<string, Promise<void>>();
  vi.stubGlobal("navigator", { locks: { request: (name: string, work: () => Promise<void> | void) => {
    const next = (queues.get(name) ?? Promise.resolve()).then(work);
    queues.set(name, next.catch(() => {}));
    return next;
  } } });
}

describe("createNoteSync", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("should send page-held changes when even enumerating browser storage is blocked", async () => {
    const storage = memoryStorage();
    Object.defineProperty(storage, "length", { get: () => { throw new Error("storage disabled"); } });
    const server = fakeServer();
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await expect(sync.load()).resolves.toBeUndefined();
    await expect(sync.change({ kind: "put", note: note("a"), before: null })).resolves.toBeUndefined();
    expect(server.notes).toEqual([note("a")]);
    expect(sync.state().phase).toBe("storage-unavailable");
  });

  it("should retain a refused state when storage cannot save its refusal marker", async () => {
    const storage = memoryStorage();
    const setItem = storage.setItem;
    storage.setItem = (key, value) => { if (key.endsWith(".rejected")) throw new Error("quota"); setItem(key, value); };
    const server = fakeServer();
    server.answers = 422;
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.change({ kind: "put", note: note("a"), before: null });
    server.answers = null;
    await sync.refresh();
    expect(sync.state().phase).toBe("rejected");
    expect(server.sent).toEqual([]);
    await sync.retry();
    expect(server.notes).toEqual([note("a")]);
  });

  it("should retain a held refusal after concurrent reconciliation when its marker cannot be stored", async () => {
    const storage = memoryStorage();
    const setItem = storage.setItem;
    storage.setItem = (key, value) => { if (key.endsWith(".rejected")) throw new Error("quota"); setItem(key, value); };
    const server = fakeServer();
    let start = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const attempts: string[] = [];
    const changeNote = server.api.changeNote;
    server.api.changeNote = async (bookId, change) => {
      const id = change.kind === "put" ? change.note.id : change.id;
      attempts.push(id);
      if (attempts.length === 1) { start(); await held; throw new ApiFailure("refused", "DeepRead did not take it.", 422); }
      await changeNote(bookId, change);
    };
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    const first = sync.change({ kind: "put", note: note("a"), before: null });
    await started;
    const second = sync.change({ kind: "put", note: note("b"), before: null });
    release();
    await Promise.all([first, second]);
    expect(sync.state()).toMatchObject({ phase: "rejected", pending: 2 });
    expect(sync.current()).toEqual([note("a"), note("b")]);
    expect(server.notes).toEqual([]);
    expect(attempts).toEqual(["a"]);
    await sync.retry();
    expect(server.notes).toEqual([note("a"), note("b")]);
    expect(attempts).toEqual(["a", "a", "b"]);
  });

  it("should not readopt acknowledged legacy notes when their source cannot be cleared", async () => {
    const legacy = "deepread.pendingNotes.single.book";
    const storage = memoryStorage({ [legacy]: JSON.stringify([{ kind: "put", note: note("a"), before: null }]) });
    const removeItem = storage.removeItem;
    storage.removeItem = (key) => { if (key === legacy) throw new Error("storage disabled"); removeItem(key); };
    const server = fakeServer();
    const open = () => createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    const first = open();
    await first.load();
    await first.change({ kind: "remove", id: "a" });
    first.close();
    const reopened = open();
    await reopened.load();
    expect(server.notes).toEqual([]);
    expect(reopened.current()).toEqual([]);
    expect(server.sent.map((change) => change.kind)).toEqual(["put", "remove"]);
    storage.removeItem = removeItem;
    await reopened.retry();
    expect(storage.length).toBe(0);
  });

  it("should not readopt explicitly discarded legacy changes when their source cannot be cleared", async () => {
    const legacy = "deepread.pendingNotes.single.book";
    const storage = memoryStorage({ [legacy]: JSON.stringify([{ kind: "put", note: note("a"), before: null }]) });
    const removeItem = storage.removeItem;
    storage.removeItem = (key) => { if (key === legacy) throw new Error("storage disabled"); removeItem(key); };
    const server = fakeServer();
    server.answers = 422;
    const open = () => createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    const first = open();
    await first.load();
    expect(first.state().phase).toBe("rejected");
    await first.discardRejected();
    expect(first.current()).toEqual([]);
    first.close();
    server.answers = null;
    const reopened = open();
    await reopened.load();
    expect(server.notes).toEqual([]);
    expect(reopened.current()).toEqual([]);
    expect(server.sent).toEqual([]);
    storage.removeItem = removeItem;
    await reopened.retry();
    expect(storage.length).toBe(0);
  });

  it("should durably append in another tab while a network request is held and retain it after navigation", async () => {
    mockBrowserLocks();
    const storage = memoryStorage();
    const server = fakeServer();
    let start = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const changeNote = server.api.changeNote;
    server.api.changeNote = async (bookId, change) => {
      if (change.kind === "put" && change.note.id === "a") { start(); await held; }
      await changeNote(bookId, change);
    };
    const open = () => createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    const first = open();
    const second = open();
    const addingFirst = first.change({ kind: "put", note: note("a"), before: null });
    await started;
    const addingSecond = second.change({ kind: "put", note: note("b"), before: null });
    second.close();
    try { await vi.waitFor(() => expect(storage.length).toBe(2)); }
    finally { release(); }
    await Promise.all([addingFirst, addingSecond]);
    const reopened = open();
    await reopened.load();
    expect(server.notes).toEqual([note("a"), note("b")]);
    expect(server.sent).toHaveLength(2);
    expect(storage.length).toBe(0);
  });

  it("should serialize allocation too when another tab removes a note during its durable append", async () => {
    mockBrowserLocks();
    const storage = memoryStorage();
    const server = fakeServer();
    const open = () => createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    const first = open();
    const second = open();
    await Promise.all([first.load(), second.load()]);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("z").mockReturnValueOnce("a") });
    let removing: Promise<void> | undefined;
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key.endsWith(".z")) removing = second.change({ kind: "remove", id: "a" });
      setItem(key, value);
    };
    await first.change({ kind: "put", note: note("a"), before: null });
    await removing;
    await second.refresh();
    expect(server.sent.map((change) => change.kind)).toEqual(["put", "remove"]);
    expect(server.notes).toEqual([]);
    expect(second.current()).toEqual([]);
  });

  it("should still recover a valid pending change beside unreadable storage data", async () => {
    const change: NoteChange = { kind: "put", note: note("a"), before: null };
    const storage = memoryStorage({ "deepread.pendingNotes.single.book.operations.bad": "not JSON", "deepread.pendingNotes.single.book.operations.good": JSON.stringify({ order: 1, change }) });
    const server = fakeServer();
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.load();
    expect(server.notes).toEqual([note("a")]);
    expect(sync.current()).toEqual([note("a")]);
    expect(sync.state().phase).toBe("storage-unavailable");
    expect(storage.getItem("deepread.pendingNotes.single.book.operations.bad")).toBe("not JSON");
  });

  it("should finish a temporarily blocked legacy migration without resurrecting it after removal", async () => {
    const change: NoteChange = { kind: "put", note: note("a"), before: null };
    const storage = memoryStorage({ "deepread.pendingNotes.single.book": JSON.stringify([change]) });
    const setItem = storage.setItem;
    storage.setItem = () => { throw new Error("storage disabled"); };
    const server = fakeServer();
    server.reachable = false;
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.load();
    expect(sync.current()).toEqual([note("a")]);
    storage.setItem = setItem;
    server.reachable = true;
    await sync.retry();
    await sync.change({ kind: "remove", id: "a" });
    await sync.refresh();
    expect(server.notes).toEqual([]);
    expect(storage.length).toBe(0);
    expect(server.sent.map((operation) => operation.kind)).toEqual(["put", "remove"]);
  });

  it("should order held cross-tab writes so a stale put cannot undo a later removal", async () => {
    mockBrowserLocks();
    const server = fakeServer();
    const storage = memoryStorage();
    const open = () => createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    const first = open();
    const second = open();
    await Promise.all([first.load(), second.load()]);
    let start = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const changeNote = server.api.changeNote;
    server.api.changeNote = async (bookId, change) => {
      if (change.kind === "put") { start(); await held; }
      await changeNote(bookId, change);
    };
    const adding = first.change({ kind: "put", note: note("a"), before: null });
    await started;
    const removing = second.change({ kind: "remove", id: "a" });
    release();
    await Promise.all([adding, removing]);
    await first.refresh();
    expect(server.sent).toEqual([{ kind: "put", note: note("a"), before: null }, { kind: "remove", id: "a" }]);
    expect(first.current()).toEqual([]);
    expect(storage.length).toBe(0);
  });

  it("should persist a change arriving during an earlier request before sending it", async () => {
    const storage = memoryStorage();
    const server = fakeServer();
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    let firstStarted = () => {};
    let secondStarted = () => {};
    const startedFirst = new Promise<void>((resolve) => { firstStarted = resolve; });
    const startedSecond = new Promise<void>((resolve) => { secondStarted = resolve; });
    const heldFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const heldSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const changeNote = server.api.changeNote;
    server.api.changeNote = async (bookId, change) => {
      if (change.kind === "put" && change.note.id === "a") { firstStarted(); await heldFirst; }
      else { secondStarted(); await heldSecond; }
      await changeNote(bookId, change);
    };
    const open = () => createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    const first = open();
    const addingFirst = first.change({ kind: "put", note: note("a"), before: null });
    await startedFirst;
    const addingSecond = first.change({ kind: "put", note: note("b"), before: null });
    expect(first.state().durable).toBe(false);
    releaseFirst();
    await startedSecond;
    const reopened = open();
    expect(reopened.current()).toEqual([note("b")]);
    releaseSecond();
    await Promise.all([addingFirst, addingSecond]);
    expect(server.notes).toEqual([note("a"), note("b")]);
  });

  it.each(["deepread.pendingNotes.single.book", "deepread.pendingNotes.single.book.operations.unreadable"])("should expose and retain unreadable recovery data at %s while still saving new changes", async (key) => {
    const storage = memoryStorage({ [key]: "not JSON" });
    const server = fakeServer();
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.load();
    expect(storage.getItem(key)).toBe("not JSON");
    expect(sync.state().phase).toBe("storage-unavailable");
    await sync.change({ kind: "put", note: note("a"), before: null });
    expect(server.notes).toEqual([note("a")]);
    expect(storage.getItem(key)).toBe("not JSON");
    expect(sync.state().phase).toBe("storage-unavailable");
  });

  it("should not resend acknowledged operations when browser cleanup fails", async () => {
    const storage = memoryStorage();
    storage.removeItem = () => { throw new Error("storage disabled"); };
    const server = fakeServer();
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.change({ kind: "put", note: note("a"), before: null });
    await sync.refresh();
    expect(server.sent).toHaveLength(1);
    sync.close();
    const reopened = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await reopened.load();
    expect(server.sent).toHaveLength(1);
    expect(reopened.current()).toEqual([note("a")]);
  });

  it("should report saving until acknowledged, then distinguish durable offline work and expired sessions", async () => {
    const server = fakeServer();
    const states: string[] = [];
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage: memoryStorage(), onChange: () => {}, onStatus: (state) => states.push(state.phase) });
    await sync.load();
    let release = () => {};
    const acknowledged = new Promise<void>((resolve) => (release = resolve));
    const changeNote = server.api.changeNote;
    server.api.changeNote = async (bookId, change) => { await acknowledged; await changeNote(bookId, change); };
    const saving = sync.change({ kind: "put", note: note("a"), before: null });
    expect(sync.state()).toMatchObject({ phase: "saving", pending: 1 });
    release();
    await saving;
    expect(sync.state()).toMatchObject({ phase: "saved", pending: 0 });
    server.reachable = false;
    await sync.change({ kind: "put", note: note("b"), before: null });
    expect(sync.state()).toMatchObject({ phase: "offline", pending: 1, durable: true });
    server.reachable = true;
    server.answers = 401;
    await sync.retry();
    expect(sync.state()).toMatchObject({ phase: "offline", pending: 1, reason: "sign-in" });
    server.answers = null;
    await sync.retry();
    expect(server.notes).toEqual([note("a"), note("b")]);
    expect(states).toContain("offline");
    expect(states.at(-1)).toBe("saved");
  });

  it("should keep two offline tabs' additions and retry them once without resurrecting a removed note", async () => {
    const server = fakeServer();
    server.reachable = false;
    const storage = memoryStorage();
    const open = () => createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    const first = open();
    const second = open();
    await first.change({ kind: "put", note: note("a"), before: null });
    await second.change({ kind: "put", note: note("b"), before: null });
    expect(storage.length).toBe(2);
    const reopened = open();
    await reopened.load();
    expect(reopened.current()).toEqual([note("a"), note("b")]);
    server.reachable = true;
    await reopened.retry();
    await reopened.change({ kind: "remove", id: "a" });
    await first.change({ kind: "put", note: note("c"), before: null });
    await second.refresh();
    expect(server.notes).toEqual([note("b"), note("c")]);
    expect(second.current()).toEqual([note("b"), note("c")]);
    expect(server.sent).toHaveLength(4);
    expect(storage.length).toBe(0);
  });

  it("should preserve pending work in memory and expose unavailable storage until it can save", async () => {
    const server = fakeServer();
    server.reachable = false;
    const storage = memoryStorage();
    const setItem = storage.setItem;
    storage.setItem = () => { throw new Error("quota exceeded"); };
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.change({ kind: "put", note: note("a"), before: null });
    expect(sync.current()).toEqual([note("a")]);
    expect(sync.state()).toMatchObject({ phase: "storage-unavailable", pending: 1, durable: false });
    storage.setItem = setItem;
    await sync.retry();
    expect(sync.state()).toMatchObject({ phase: "offline", pending: 1, durable: true });
    sync.close();
    server.reachable = true;
    const reopened = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await reopened.load();
    expect(server.notes).toEqual([note("a")]);
  });

  it("should discard only rejected operations and retain the reader's other pending changes", async () => {
    const server = fakeServer();
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage: memoryStorage(), onChange: () => {} });
    await sync.load();
    server.answers = 422;
    await sync.change({ kind: "put", note: note("a"), before: null });
    await sync.change({ kind: "put", note: note("b"), before: null });
    server.answers = null;
    await sync.discardRejected();
    expect(server.notes).toEqual([note("b")]);
    expect(sync.current()).toEqual([note("b")]);
  });

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

  it("should retain a refused change across reloads until the reader retries or discards it", async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.load();

    server.exists = false;
    await sync.change({ kind: "put", note: note("late"), before: null });
    expect(sync.current()).toEqual([note("late")]);
    expect(sync.state()).toMatchObject({ phase: "rejected", pending: 1, durable: true });
    sync.close();
    const reopened = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await reopened.load();
    expect(reopened.current()).toEqual([note("late")]);
    expect(reopened.state().phase).toBe("rejected");
    server.exists = true;
    await reopened.retry();
    expect(reopened.state()).toMatchObject({ phase: "saved", pending: 0 });
    expect(server.notes).toEqual([note("late")]);
    expect(storage.length).toBe(0);
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
    expect(storage.length).toBe(1);
    first.close();

    server.answers = null;
    const second = createNoteSync({ ...owner, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await second.load();
    expect(server.notes).toEqual([note("late")]);
    expect(storage.length).toBe(0);
  });

  it("should show a note another device added when the page refreshes", async () => {
    const server = fakeServer([note("a")]);
    const seen: Note[][] = [];
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage: memoryStorage(), onChange: (notes: Note[]) => seen.push(notes) });
    await sync.load();

    server.notes = [note("a"), note("b")];
    await sync.refresh();

    expect(seen.at(-1)).toEqual([note("a"), note("b")]);
    expect(sync.current()).toEqual([note("a"), note("b")]);
  });

  it("should not report again when a refresh finds the same notes", async () => {
    const server = fakeServer([note("a")]);
    const seen: Note[][] = [];
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage: memoryStorage(), onChange: (notes: Note[]) => seen.push(notes) });
    await sync.load();
    server.calls.length = 0;
    const reported = seen.length;

    // DeepRead answers with a new list holding the same notes: nothing for the page to redraw.
    server.notes = server.notes.map((kept) => ({ ...kept }));
    await sync.refresh();

    expect(server.calls).toEqual(["read"]);
    expect(seen).toHaveLength(reported);
  });

  it("should still show a change made while a refresh is waiting for DeepRead", async () => {
    const server = fakeServer([note("a")]);
    const seen: Note[][] = [];
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage: memoryStorage(), onChange: (notes: Note[]) => seen.push(notes) });
    await sync.load();
    server.calls.length = 0;
    seen.length = 0;

    let release = () => {};
    server.holdReads = new Promise<void>((resolve) => (release = resolve));
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(server.calls).toEqual(["read"]));

    // What DeepRead is about to answer was made before this note, so it lacks it.
    const adding = sync.change({ kind: "put", note: note("b"), before: null });
    release();
    await Promise.all([refreshing, adding]);

    expect(seen).toEqual([[note("a"), note("b")]]);
    expect(server.notes).toEqual([note("a"), note("b")]);
  });

  it("should send the changes waiting in the outbox before a refresh fetches", async () => {
    const server = fakeServer([note("a")]);
    const storage = memoryStorage();
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage, onChange: () => {} });
    await sync.load();

    server.reachable = false;
    await sync.change({ kind: "put", note: note("b"), before: null });
    expect(storage.length).toBe(1);

    server.reachable = true;
    server.calls.length = 0;
    await sync.refresh();

    expect(server.calls).toEqual(["change", "read"]);
    expect(server.notes).toEqual([note("a"), note("b")]);
    expect(sync.current()).toEqual([note("a"), note("b")]);
    expect(storage.length).toBe(0);
  });

  it("should fetch once for refreshes asked at the same time, and again for the next one", async () => {
    const server = fakeServer([note("a")]);
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage: memoryStorage(), onChange: () => {} });
    await sync.load();
    server.calls.length = 0;

    const first = sync.refresh();
    const second = sync.refresh();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(server.calls).toEqual(["read"]);

    await sync.refresh();
    expect(server.calls).toEqual(["read", "read"]);
  });

  it("should keep what is shown when a refresh cannot reach DeepRead, and do nothing once closed", async () => {
    const server = fakeServer([note("a")]);
    const seen: Note[][] = [];
    const sync = createNoteSync({ ...single, bookId: "book", lang: "bn", api: server.api, storage: memoryStorage(), onChange: (notes: Note[]) => seen.push(notes) });
    await sync.load();
    const reported = seen.length;

    server.reachable = false;
    await expect(sync.refresh()).resolves.toBeUndefined();
    expect(sync.current()).toEqual([note("a")]);
    expect(seen).toHaveLength(reported);

    server.reachable = true;
    server.calls.length = 0;
    server.notes = [note("a"), note("b")];
    sync.close();
    await sync.refresh();
    expect(server.calls).toEqual([]);
    expect(seen).toHaveLength(reported);
  });
});
