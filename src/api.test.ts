import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api requests that fail", () => {
  it("should say DeepRead is not reachable when the request never gets an answer", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(api.listBooks()).rejects.toMatchObject({
      message: "DeepRead is not reachable. Check that it is running, then try again.",
    });
  });

  it("should say the same without an HTTP code when a proxy answers with a page instead of JSON", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html>Bad gateway</html>", { status: 502 })));

    const error = await api.listBooks().catch((err: Error) => err);

    expect(error).toMatchObject({ message: "DeepRead is not reachable. Check that it is running, then try again." });
    expect((error as Error).message).not.toMatch(/\d{3}/);
  });

  it("should keep the server's own sentence when it sends one", async () => {
    const body = JSON.stringify({ error: "invalid_title", message: "The title cannot be empty. Type a title for this book." });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status: 400 })));

    await expect(api.updateBook("a-b", { title: "" })).rejects.toMatchObject({
      code: "invalid_title",
      message: "The title cannot be empty. Type a title for this book.",
    });
  });

  it("should pass a cancelled request on untouched when the caller aborted it", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", () => Promise.reject(aborted));

    await expect(api.getChapter("a-b", "c1", controller.signal)).rejects.toBe(aborted);
  });
});

describe("api.uploadBook", () => {
  const file = new File(["%PDF-1.4"], "book.pdf", { type: "application/pdf" });
  const bookJson = JSON.stringify({ id: "book-12345678", title: "Book" });

  it("should say the library already held the book when the server answers 200", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(bookJson, { status: 200 })));

    await expect(api.uploadBook(file)).resolves.toMatchObject({ book: { id: "book-12345678" }, alreadyHad: true });
  });

  it("should say the book is new when the server answers 201", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(bookJson, { status: 201 })));

    await expect(api.uploadBook(file)).resolves.toMatchObject({ book: { id: "book-12345678" }, alreadyHad: false });
  });
});
