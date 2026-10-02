import { afterEach, describe, expect, it, vi } from "vitest";
import { api, streamText } from "./api.ts";

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

describe("streamText", () => {
  /** A streamed answer that sends `frames`, then closes normally or breaks off like a lost connection. */
  const answer = (frames: string[], end: "close" | "break") =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        },
        // The ending comes a moment after the text, as it does over a real connection.
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (end === "close") controller.close();
          else controller.error(new TypeError("network error"));
        },
      }),
    );

  it("should fail with a sentence when the answer stops before the server says it is done", async () => {
    for (const end of ["close", "break"] as const) {
      vi.stubGlobal("fetch", () => Promise.resolve(answer(['event: delta\ndata: {"text":"In sim"}\n\n'], end)));
      const seen: string[] = [];

      await expect(streamText("/api/ai/explain", {}, (text) => seen.push(text))).rejects.toMatchObject({
        code: "cut_off",
        message: "The answer stopped before it was finished.",
      });
      expect(seen).toEqual(["In sim"]);
    }
  });
});
