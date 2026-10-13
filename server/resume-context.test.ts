import { describe, expect, it, vi } from "vitest";
import type { Note, ParsedBook, ResumeContextResponse } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import { createApp } from "./app.ts";
import { LibraryClosedError, type Library } from "./library.ts";

const book: ParsedBook = {
  title: "Book", author: null, pageCount: 1, warnings: [], chapters: [{
    id: "c1", title: "One", startPage: 1, endPage: 1,
    blocks: [{ id: "b1", type: "paragraph", text: "Before the saved place. Unread text.", page: 1 }],
  }],
};
const note: Note = { id: "h1", chapterId: "c1", blockId: "b1", offset: 0, quote: "Before", lang: "bn", mode: "highlight", color: "yellow" };
const position = "chapterId=c1&blockId=b1&offset=23";

function setup() {
  const reads = { book: vi.fn<Library["book"]>().mockResolvedValue(book), notes: vi.fn<Library["notes"]>().mockResolvedValue([note]) };
  const app = createApp({
    library: reads as unknown as Library,
    parsePdf: async () => book, renderCover: async () => null,
    llm: {} as Ai, quickTranslate: async (text) => text,
  });
  const request = async (query = position) => app.request(`/api/books/book/resume?${query}`);
  return { ...reads, app, request };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => { resolve = ready; });
  return { promise, resolve };
}

describe("compact saved reading context", () => {
  it("reads book and notes concurrently and waits for both authorization checks", async () => {
    const state = setup();
    const pendingBook = deferred<ParsedBook | null>();
    const pendingNotes = deferred<Note[] | null>();
    state.book.mockReturnValue(pendingBook.promise);
    state.notes.mockReturnValue(pendingNotes.promise);
    let complete = false;
    const response = state.request().then((value) => { complete = true; return value; });
    await vi.waitFor(() => expect(state.notes).toHaveBeenCalledOnce());
    expect(state.book).toHaveBeenCalledExactlyOnceWith("book");
    expect(complete).toBe(false);
    pendingBook.resolve(book);
    pendingNotes.resolve(null);
    expect((await response).status).toBe(404);
  });

  it("returns only bounded preceding text and nearest highlight, without chapters or notes", async () => {
    const state = setup();
    const largeBook: ParsedBook = { ...book, chapters: [{ ...book.chapters[0]!, blocks: [
      { id: "previous", type: "paragraph", text: "Earlier ".repeat(100_000), page: 1 },
      book.chapters[0]!.blocks[0]!,
      { id: "image", type: "image", page: 1, text: "", image: { src: "data:image/png;base64," + "x".repeat(1_000_000), width: 1000, height: 1000, alt: "Unread figure" } },
    ] }] };
    state.book.mockResolvedValue(largeBook);
    state.notes.mockResolvedValue([note, ...Array.from({ length: 500 }, (_, index): Note => ({ ...note, id: `future-${index}`, chapterId: "future", quote: "x".repeat(5000) }))]);
    const response = await state.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    expect(text.length).toBeLessThan(1200);
    const result = JSON.parse(text) as ResumeContextResponse;
    expect(result.chapter).toEqual({ id: "c1", title: "One" });
    expect(result.context?.excerpt.length).toBeLessThanOrEqual(600);
    expect(result.context?.excerpt.endsWith("Before the saved place.")).toBe(true);
    expect(result.context?.highlight).toEqual({ quote: "Before", page: 1, blockId: "b1", offset: 0 });
    expect(result.noteError).toBeNull();
    expect(text).not.toContain("Unread");
    expect(text).not.toContain("base64");
    expect(text).not.toContain("future-");
  });

  it("rejects malformed anchors and unsafe offsets before reading the library", async () => {
    const state = setup();
    const invalid = [
      "", "chapterId=c1&blockId=b1", "chapterId=&blockId=b1&offset=0", "chapterId=c1&blockId=%20&offset=0",
      `chapterId=${"c".repeat(201)}&blockId=b1&offset=0`, `chapterId=c1&blockId=${"b".repeat(201)}&offset=0`,
      ...["-1", "1.2", "Infinity", "NaN", "9007199254740992", "1e2", ""].map((offset) => `chapterId=c1&blockId=b1&offset=${offset}`),
      `${position}&chapterId=c2`, `${position}&blockId=b2`, `${position}&offset=1`,
    ];
    for (const query of invalid) expect((await state.request(query)).status, query).toBe(400);
    expect(state.book).not.toHaveBeenCalled();
    expect(state.notes).not.toHaveBeenCalled();
  });

  it("accepts previously valid saved anchors at the progress writer's 200 character limit", async () => {
    const state = setup();
    const chapterId = "c".repeat(200);
    const blockId = "b".repeat(200);
    state.book.mockResolvedValue({ ...book, chapters: [{ ...book.chapters[0]!, id: chapterId, blocks: [{ ...book.chapters[0]!.blocks[0]!, id: blockId }] }] });
    const response = await state.request(`chapterId=${chapterId}&blockId=${blockId}&offset=23`);
    expect(response.status).toBe(200);
    expect((await response.json() as ResumeContextResponse).context?.excerpt).toBe("Before the saved place.");
  });

  it("rechecks both reads on every request and denies access loss in either one", async () => {
    const state = setup();
    expect((await state.request()).status).toBe(200);
    state.book.mockResolvedValue(null);
    expect((await state.request()).status).toBe(404);
    state.book.mockResolvedValue(book);
    state.notes.mockResolvedValue(null);
    expect((await state.request()).status).toBe(404);
    expect(state.book).toHaveBeenCalledTimes(3);
    expect(state.notes).toHaveBeenCalledTimes(3);
  });

  it("denies a removed profile or authorization exception after book text arrives", async () => {
    const state = setup();
    state.notes.mockRejectedValue(new LibraryClosedError());
    const closed = await state.request();
    expect(closed.status).toBe(401);
    expect(await closed.text()).not.toContain("Before");
    for (const status of [401, 403, 404]) {
      state.notes.mockRejectedValue(Object.assign(new Error("Access ended"), { status }));
      const refused = await state.request();
      expect(refused.status).toBe(404);
      expect(await refused.text()).not.toContain("Before");
    }
  });

  it("retains an authorized bounded passage when only highlight storage failed", async () => {
    const state = setup();
    state.notes.mockRejectedValue(new Error("Temporary storage failure"));
    const response = await state.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      chapter: { id: "c1", title: "One" },
      context: { state: "ready", excerpt: "Before the saved place.", highlight: null },
      noteError: "Your highlights could not be loaded.",
    });
  });

  it("returns missing context for deleted chapters and blocks without exposing another passage", async () => {
    const state = setup();
    expect(await (await state.request("chapterId=gone&blockId=b1&offset=23")).json()).toEqual({ chapter: null, context: null, noteError: null });
    expect(await (await state.request("chapterId=c1&blockId=gone&offset=23")).json()).toEqual({
      chapter: { id: "c1", title: "One" }, context: { state: "missing", excerpt: "", highlight: null }, noteError: null,
    });
  });
});
