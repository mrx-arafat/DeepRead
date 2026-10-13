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

  type Progress = { lengthComputable: boolean; loaded: number; total: number };

  /** XMLHttpRequest as the browser drives it: the body goes in two halves, then the server answers (or the network fails). */
  const fakeXhr = (answer: { status: number; body: string } | "network-error" | "never") =>
    class {
      upload: { onprogress: ((event: Progress) => void) | null; onload: ((event: Progress) => void) | null } = { onprogress: null, onload: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 0;
      response: Blob | null = null;
      responseType = "";
      open() {}
      abort() {
        this.onabort?.();
      }
      send() {
        if (answer === "never") return;
        queueMicrotask(() => {
          if (answer === "network-error") return this.onerror?.();
          this.upload.onprogress?.({ lengthComputable: true, loaded: 500, total: 1000 });
          this.upload.onload?.({ lengthComputable: true, loaded: 1000, total: 1000 });
          this.status = answer.status;
          this.response = new Blob([answer.body]);
          this.onload?.();
        });
      }
    };

  it("should say the library already held the book when the server answers 200", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200, body: bookJson }));

    await expect(api.uploadBook(file)).resolves.toMatchObject({ book: { id: "book-12345678" }, alreadyHad: true });
  });

  it("should say the book is new and report every byte sent when the server answers 201", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 201, body: bookJson }));
    const sent: number[] = [];

    const result = await api.uploadBook(file, { onSent: (bytes, total) => sent.push(bytes / total) });

    expect(result).toMatchObject({ book: { id: "book-12345678" }, alreadyHad: false });
    expect(sent).toEqual([0.5, 1]);
  });

  it("should say DeepRead is not reachable when a proxy answers with its own error page", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 500, body: "<html>500 Internal Server Error</html>" }));

    await expect(api.uploadBook(file)).rejects.toMatchObject({
      status: 500,
      message: "DeepRead is not reachable. Check that it is running, then try again.",
    });
  });

  it("should say DeepRead is not reachable when the upload never gets an answer", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr("network-error"));

    await expect(api.uploadBook(file)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("should stop with an AbortError when the reader cancels the upload", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr("never"));
    const stop = new AbortController();

    const upload = api.uploadBook(file, { signal: stop.signal });
    stop.abort();

    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
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

describe("api.saveProgress", () => {
  it("should open another book immediately while waiting for saves to the book just left", async () => {
    const calls: string[] = [];
    const answerSaves: (() => void)[] = [];
    vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "PUT") return new Promise<Response>((resolve) => answerSaves.push(() => resolve(new Response("{}"))));
      return Promise.resolve(new Response("{}"));
    });

    const firstSave = api.saveProgress("a-b", "c1", "c1-b1", 0);
    const secondSave = api.saveProgress("a-b", "c1", "c1-b2", 0);
    const reopened = api.getBook("a-b");
    await api.getBook("other-book");
    expect(calls).toEqual(["PUT /api/books/a-b/progress", "PUT /api/books/a-b/progress", "GET /api/books/other-book"]);

    // A faster newer save must not hide an older request still being written.
    answerSaves[1]!();
    await secondSave;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).not.toContain("GET /api/books/a-b");
    answerSaves[0]!();
    await firstSave;
    await reopened;
    expect(calls.at(-1)).toBe("GET /api/books/a-b");
  });

  it("should wait for pending saves across books before refreshing the shelf", async () => {
    const calls: string[] = [];
    const answerSaves: (() => void)[] = [];
    vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "PUT") return new Promise<Response>((resolve) => answerSaves.push(() => resolve(new Response("{}"))));
      return Promise.resolve(new Response("[]"));
    });
    const firstSave = api.saveProgress("a-b", "c1", "c1-b1", 0);
    const secondSave = api.saveProgress("other-book", "c1", "c1-b1", 0);
    const listed = api.listBooks();
    answerSaves[1]!();
    await secondSave;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).not.toContain("GET /api/books");
    answerSaves[0]!();
    await firstSave;
    await listed;
    expect(calls.at(-1)).toBe("GET /api/books");
  });

  it("should release a book waiting for a rejected save", async () => {
    let rejectSave: (reason: Error) => void = () => {};
    vi.stubGlobal("fetch", (_path: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Promise<Response>((_resolve, reject) => (rejectSave = reject))
        : Promise.resolve(new Response("{}")),
    );
    const saved = api.saveProgress("a-b", "c1", "c1-b1", 0).catch(() => {});
    const reopened = api.getBook("a-b");
    rejectSave(new TypeError("Failed to fetch"));
    await saved;
    await expect(reopened).resolves.toEqual({});
  });

  it("should be on its way before the library asks for the books, so the shelf shows the place just left", async () => {
    const calls: string[] = [];
    let answerSave: () => void = () => {};
    vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "PUT") return new Promise<Response>((resolve) => (answerSave = () => resolve(new Response("{}", { status: 200 }))));
      return Promise.resolve(new Response("[]", { status: 200 }));
    });

    const saved = api.saveProgress("a-b", "c1", "c1-b1", 0);
    const listed = api.listBooks();
    await Promise.resolve();
    expect(calls).toEqual(["PUT /api/books/a-b/progress"]);

    answerSave();
    await saved;
    await listed;
    expect(calls).toEqual(["PUT /api/books/a-b/progress", "GET /api/books"]);
  });

  it("should not hold the library up when the save fails", async () => {
    vi.stubGlobal("fetch", (_path: string, init?: RequestInit) =>
      init?.method === "PUT" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(new Response("[]", { status: 200 })),
    );

    await api.saveProgress("a-b", "c1", "c1-b1", 0).catch(() => {});
    await expect(api.listBooks()).resolves.toEqual([]);
  });
});
