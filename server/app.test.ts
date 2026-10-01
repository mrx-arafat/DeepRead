// Functional test of the HTTP API: real routes and real disk storage in a temp dir,
// with the PDF parser, the model and the translator replaced by fakes (no network, no model process).
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, BookDetail, BookSummary, ParsedBook } from "../shared/types.ts";
import { createApp } from "./app.ts";
import type { ParsePdf } from "./deps.ts";
import { LlmError } from "./llm.ts";
import type { Llm, LlmRequest } from "./llm.ts";
import { ParseError } from "./parser/errors.ts";

const sampleBook = (title = "Sample Book"): ParsedBook => ({
  title,
  author: "A. Writer",
  pageCount: 4,
  warnings: ["one warning"],
  chapters: [
    {
      id: "c1",
      title: "First Chapter",
      startPage: 1,
      endPage: 2,
      blocks: [
        { id: "c1-b0", type: "heading", level: 1, text: "First Chapter", page: 1 },
        { id: "c1-b1", type: "paragraph", text: "Alpha paragraph has five words.", page: 1 },
        { id: "c1-b2", type: "paragraph", text: "Beta paragraph is the one the reader taps.", page: 1 },
        { id: "c1-b3", type: "paragraph", text: "Gamma paragraph comes after.", page: 2 },
      ],
    },
    {
      id: "c2",
      title: "Second Chapter",
      startPage: 3,
      endPage: 4,
      blocks: [
        { id: "c2-b0", type: "heading", level: 1, text: "Second Chapter", page: 3 },
        { id: "c2-b1", type: "paragraph", text: "Only paragraph here.", page: 3 },
      ],
    },
  ],
});

// The fake parser reads the uploaded file from disk, so these bytes stand in for a real PDF.
const pdfBytes = (content: ParsedBook | "SCANNED") =>
  `%PDF-1.4\n${content === "SCANNED" ? content : JSON.stringify(content)}`;

const fakeParsePdf: ParsePdf = async (path) => {
  const text = await readFile(path, "utf8");
  const body = text.slice(text.indexOf("\n") + 1);
  if (body.startsWith("SCANNED")) throw new ParseError("scanned", "This PDF looks like a scan.");
  return JSON.parse(body) as ParsedBook;
};

type Script = (request: LlmRequest, call: number) => Iterable<string> | AsyncIterable<string>;

function fakeLlm() {
  const state = { calls: 0, aborted: false, script: ((): Iterable<string> => ["ok"]) as Script };
  const llm: Llm = {
    streamText(request) {
      state.calls += 1;
      const call = state.calls;
      return (async function* () {
        yield* state.script(request, call);
      })();
    },
  };
  return { llm, state };
}

type SseEvent = { event: string; data: Record<string, unknown> };

async function readSse(response: Response): Promise<SseEvent[]> {
  return (await response.text())
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      return {
        event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "",
        data: JSON.parse(lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "null") as Record<string, unknown>,
      };
    });
}

// A directory that was never created holds nothing, which is also a pass for "left nothing behind".
const entries = (path: string) => readdir(path).catch(() => [] as string[]);

const textOf = (events: SseEvent[]) =>
  events
    .filter((e) => e.event === "delta")
    .map((e) => e.data.text)
    .join("");

describe("DeepRead API", () => {
  let dataDir: string;
  let app: Hono;
  let llm: ReturnType<typeof fakeLlm>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-test-"));
    llm = fakeLlm();
    app = createApp({
      dataDir,
      parsePdf: fakeParsePdf,
      llm: llm.llm,
      quickTranslate: async (text, lang) => {
        if (text === "boom") throw new Error("service down");
        return `${lang}:${text}`;
      },
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const upload = (content: ParsedBook | "SCANNED" | string, name = "book.pdf") => {
    const form = new FormData();
    const bytes = typeof content === "string" && content !== "SCANNED" ? content : pdfBytes(content as ParsedBook | "SCANNED");
    form.set("file", new File([bytes], name, { type: "application/pdf" }));
    return app.request("/api/books", { method: "POST", body: form });
  };
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  const addBook = async (book = sampleBook()) => ((await (await upload(book)).json()) as { id: string }).id;
  const explainBody = (id: string, extra: Record<string, unknown> = {}) => ({
    bookId: id,
    chapterId: "c1",
    blockId: "c1-b2",
    selection: "reader",
    mode: "word",
    lang: "bn",
    ...extra,
  });

  describe("library", () => {
    it("should upload, list, read, track progress, serve the PDF and delete a book", async () => {
      const created = await upload(sampleBook());
      expect(created.status).toBe(201);
      const detail = (await created.json()) as Record<string, unknown>;
      const id = detail.id as string;
      expect(id).toMatch(/^sample-book-[0-9a-f]{8}$/);
      expect(detail).toMatchObject({
        title: "Sample Book",
        chapterCount: 2,
        wordCount: 24,
        progress: null,
        warnings: ["one warning"],
        chapters: [
          { id: "c1", wordCount: 19 },
          { id: "c2", wordCount: 5 },
        ],
      });

      const list = (await (await app.request("/api/books")).json()) as Array<{ id: string; wordCount: number }>;
      expect(list.map((b) => b.id)).toEqual([id]);
      expect(list[0]?.wordCount).toBe(24);
      expect(await (await app.request(`/api/books/${id}`)).json()).toEqual(detail);

      const chapter = (await (await app.request(`/api/books/${id}/chapters/c2`)).json()) as { blocks: unknown[] };
      expect(chapter.blocks).toHaveLength(2);

      const saved = await send("PUT", `/api/books/${id}/progress`, { chapterId: "c1", blockId: "c1-b3" });
      expect(saved.status).toBe(200);
      // The reader's block 3 of 3 is two thirds into the 19 words of chapter one, out of 24 in the book.
      expect(await saved.json()).toMatchObject({ blockId: "c1-b3", chapterTitle: "First Chapter", percent: 52 });
      const relisted = (await (await app.request("/api/books")).json()) as BookSummary[];
      expect(relisted[0]?.progress).toMatchObject({ blockId: "c1-b3", chapterTitle: "First Chapter", percent: 52 });

      const ranged = await app.request(`/api/books/${id}/pdf`, { headers: { Range: "bytes=0-4" } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-4\/\d+$/);
      expect(await ranged.text()).toBe("%PDF-");
      expect((await app.request(`/api/books/${id}/pdf`, { headers: { Range: "bytes=999999-" } })).status).toBe(416);

      expect((await send("DELETE", `/api/books/${id}`)).status).toBe(204);
      expect((await app.request(`/api/books/${id}`)).status).toBe(404);
      expect(await (await app.request("/api/books")).json()).toEqual([]);
      expect(await entries(join(dataDir, "books"))).toEqual([]);
    });

    it("should say where the reader stopped for a book whose progress was saved without it", async () => {
      const id = await addBook();
      const metaPath = join(dataDir, "books", id, "meta.json");
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      const legacy = { chapterId: "c2", blockId: "c2-b1", updatedAt: "2026-01-01T00:00:00.000Z" };
      await writeFile(metaPath, JSON.stringify({ ...meta, progress: legacy }));

      const list = (await (await app.request("/api/books")).json()) as BookSummary[];
      // Chapter two starts after the 19 words of chapter one, out of 24.
      expect(list[0]?.progress).toEqual({ ...legacy, chapterTitle: "Second Chapter", percent: 79 });
    });

    it("should return the existing book when the same PDF is uploaded again", async () => {
      const first = (await (await upload(sampleBook())).json()) as { id: string };
      const again = await upload(sampleBook());
      expect(again.status).toBe(200);
      expect(((await again.json()) as { id: string }).id).toBe(first.id);

      const sameTitleOtherFile = (await (await upload({ ...sampleBook(), author: "Someone Else" })).json()) as { id: string };
      expect(sameTitleOtherFile.id).not.toBe(first.id);
      expect(await readdir(join(dataDir, "books"))).toHaveLength(2);
    });

    it("should reject files that are not PDFs and leave nothing behind", async () => {
      const wrongBytes = await upload("just some text", "disguised.pdf");
      expect(wrongBytes.status).toBe(415);
      expect(((await wrongBytes.json()) as { error: string }).error).toBe("not_pdf");

      const noFile = await app.request("/api/books", { method: "POST", body: new FormData() });
      expect(noFile.status).toBe(400);

      expect(await entries(join(dataDir, "books"))).toEqual([]);
      expect(await entries(join(dataDir, "tmp"))).toEqual([]);
    });

    it("should answer 422 with the parse error kind and clean up when the PDF cannot be parsed", async () => {
      const response = await upload("SCANNED");
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "scanned", message: "This PDF looks like a scan." });
      expect(await entries(join(dataDir, "books"))).toEqual([]);
      expect(await entries(join(dataDir, "tmp"))).toEqual([]);
    });

    it("should reject book ids that could escape the data directory", async () => {
      // Bare ".." segments never reach a handler (the URL parser removes them); encoded slashes do.
      for (const id of ["..%2F..%2Fetc%2Fpasswd", "%2E%2E%2Fsecret", "Has%20Space", "a%5Cb", "UPPER"]) {
        expect((await app.request(`/api/books/${id}`)).status, `GET ${id}`).toBe(400);
        expect((await send("PATCH", `/api/books/${id}`, { title: "New" })).status, `PATCH ${id}`).toBe(400);
        expect((await send("DELETE", `/api/books/${id}`)).status, `DELETE ${id}`).toBe(400);
        expect((await app.request(`/api/books/${id}/pdf`)).status, `PDF ${id}`).toBe(400);
      }
      const viaBody = await send("POST", "/api/ai/explain", explainBody("../../etc"));
      expect(viaBody.status).toBe(400);
    });
  });

  describe("editing a book", () => {
    const patch = (id: string, body: unknown) => send("PATCH", `/api/books/${id}`, body);
    const read = async (id: string) => (await (await app.request(`/api/books/${id}`)).json()) as BookDetail;

    it("should rename the title and author everywhere, keeping the id, progress and chapters", async () => {
      const id = await addBook();
      await send("PUT", `/api/books/${id}/progress`, { chapterId: "c1", blockId: "c1-b3" });

      const response = await patch(id, { title: "  The Better Title ", author: " New Author " });
      expect(response.status).toBe(200);
      const updated = (await response.json()) as BookDetail;
      expect(updated).toMatchObject({
        id,
        title: "The Better Title",
        author: "New Author",
        chapterCount: 2,
        wordCount: 24,
        warnings: ["one warning"],
        progress: { chapterId: "c1", blockId: "c1-b3" },
      });
      expect(updated.chapters.map((c) => c.id)).toEqual(["c1", "c2"]);

      expect(await read(id)).toEqual(updated);
      const list = (await (await app.request("/api/books")).json()) as BookSummary[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id, title: "The Better Title", author: "New Author" });
      const chapter = (await (await app.request(`/api/books/${id}/chapters/c1`)).json()) as { blocks: unknown[] };
      expect(chapter.blocks).toHaveLength(4);
    });

    it("should change only the fields that are sent, and clear the author when it is empty or null", async () => {
      const id = await addBook();
      expect(await (await patch(id, { title: "Only Title" })).json()).toMatchObject({ title: "Only Title", author: "A. Writer" });
      expect(await (await patch(id, { author: "Only Author" })).json()).toMatchObject({ title: "Only Title", author: "Only Author" });

      for (const empty of ["", "   ", null]) {
        await patch(id, { author: "Someone" });
        const cleared = await patch(id, { author: empty });
        expect(await cleared.json(), JSON.stringify(empty)).toMatchObject({ title: "Only Title", author: null });
      }
      expect((await read(id)).author).toBeNull();
    });

    it("should reject an invalid update with a readable 400 and change nothing", async () => {
      const id = await addBook();
      const cases: Array<[string, unknown, string]> = [
        ["empty title", { title: "" }, "invalid_title"],
        ["blank title", { title: "  \n " }, "invalid_title"],
        ["title over 200 characters", { title: "t".repeat(201) }, "invalid_title"],
        ["title that is not text", { title: 42 }, "invalid_title"],
        ["null title", { title: null }, "invalid_title"],
        ["author over 120 characters", { author: "a".repeat(121) }, "invalid_author"],
        ["author that is not text", { author: 42 }, "invalid_author"],
        ["good author next to a bad title", { title: "", author: "Fine" }, "invalid_title"],
        ["no fields", {}, "invalid_request"],
        ["only unknown fields", { subtitle: "x" }, "invalid_request"],
        ["JSON that is not an object", "[1]", "invalid_request"],
        ["malformed JSON", "{oops", "invalid_request"],
      ];
      for (const [label, body, error] of cases) {
        const response = await patch(id, body);
        expect(response.status, label).toBe(400);
        const json = (await response.json()) as ApiError;
        expect(json.error, label).toBe(error);
        expect(json.message.length, label).toBeGreaterThan(10);
      }
      expect(await read(id)).toMatchObject({ title: "Sample Book", author: "A. Writer" });
    });

    it("should accept a title of 200 characters and an author of 120 characters, measured after trimming", async () => {
      const id = await addBook();
      const title = "t".repeat(200);
      const author = "a".repeat(120);
      const response = await patch(id, { title: ` ${title} `, author: ` ${author} ` });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ title, author });
    });

    it("should answer 404 when the book does not exist", async () => {
      const response = await patch("nope-12345678", { title: "New" });
      expect(response.status).toBe(404);
      expect(((await response.json()) as ApiError).error).toBe("book_not_found");
    });

    it("should not lose a progress save that happens at the same moment as an edit", async () => {
      const id = await addBook();
      await Promise.all([
        patch(id, { title: "The Better Title" }),
        send("PUT", `/api/books/${id}/progress`, { chapterId: "c2", blockId: "c2-b1" }),
      ]);
      expect(await read(id)).toMatchObject({ title: "The Better Title", progress: { chapterId: "c2", blockId: "c2-b1" } });
    });

    it("should give the model the edited title when the reader asks for an explanation", async () => {
      const id = await addBook();
      await patch(id, { title: "The Better Title" });
      llm.state.script = (request) => [`${request.system}\n---\n${request.user}`];

      const text = textOf(await readSse(await send("POST", "/api/ai/explain", explainBody(id))));
      expect(text).toContain("Book: The Better Title");
      expect(text).not.toContain("Sample Book");
    });

    it("should keep the edited title and author when the same PDF is uploaded again", async () => {
      const id = await addBook();
      await patch(id, { title: "The Better Title", author: null });

      const again = await upload(sampleBook());
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ id, title: "The Better Title", author: null });
      expect(await readdir(join(dataDir, "books"))).toEqual([id]);
    });

    it("should delete a book that was renamed and leave nothing behind", async () => {
      const id = await addBook();
      await patch(id, { title: "The Better Title" });

      expect((await send("DELETE", `/api/books/${id}`)).status).toBe(204);
      expect((await app.request(`/api/books/${id}`)).status).toBe(404);
      expect(await (await app.request("/api/books")).json()).toEqual([]);
      expect(await entries(join(dataDir, "books"))).toEqual([]);
      expect(await entries(join(dataDir, "tmp"))).toEqual([]);
    });
  });

  describe("explain", () => {
    it("should stream deltas then done, and serve the repeat request from the cache", async () => {
      const id = await addBook();
      llm.state.script = (_request, call) => (call === 1 ? ["Mean", "ing: ", "everywhere"] : ["a different answer"]);

      const first = await send("POST", "/api/ai/explain", explainBody(id));
      expect(first.headers.get("content-type")).toContain("text/event-stream");
      const firstEvents = await readSse(first);
      expect(firstEvents.map((e) => e.event)).toEqual(["delta", "delta", "delta", "done"]);
      expect(textOf(firstEvents)).toBe("Meaning: everywhere");
      expect(firstEvents.at(-1)?.data).toEqual({ cached: false });

      const second = await readSse(await send("POST", "/api/ai/explain", explainBody(id)));
      expect(second.map((e) => e.event)).toEqual(["delta", "done"]);
      expect(textOf(second)).toBe("Meaning: everywhere");
      expect(second.at(-1)?.data).toEqual({ cached: true });

      // A different selection is a different question, so it is not served from the cache.
      const other = await readSse(await send("POST", "/api/ai/explain", explainBody(id, { selection: "taps" })));
      expect(textOf(other)).toBe("a different answer");
    });

    it("should tell the model which paragraph the reader is on, with its neighbours labelled", async () => {
      const id = await addBook();
      llm.state.script = (request) => [`${request.task}|${request.system}\n---\n${request.user}`];

      const text = textOf(await readSse(await send("POST", "/api/ai/explain", explainBody(id))));
      // A single tapped word is its own task: it goes to the fast model.
      expect(text).toContain("word|");
      expect(text).toContain("first language is Bangla");
      expect(text).toContain("[Text just before]\nFirst Chapter\n\nAlpha paragraph has five words.");
      expect(text).toContain("[The reader is on this paragraph]\nBeta paragraph is the one the reader taps.");
      expect(text).toContain("[Text just after]\nGamma paragraph comes after.");
      expect(text).toContain('The reader tapped: "reader"');
    });

    it("should report a failed generation as an error event and never cache it", async () => {
      const id = await addBook();
      llm.state.script = (_request, call) =>
        call === 1
          ? (async function* () {
              yield "half an ans";
              throw new LlmError("timeout", "The AI took too long to answer. Please try again.");
            })()
          : ["a complete answer"];

      const failed = await readSse(await send("POST", "/api/ai/explain", explainBody(id)));
      expect(failed.map((e) => e.event)).toEqual(["delta", "error"]);
      expect(failed.at(-1)?.data).toEqual({ message: "The AI took too long to answer. Please try again." });

      const retry = await readSse(await send("POST", "/api/ai/explain", explainBody(id)));
      expect(retry.at(-1)).toEqual({ event: "done", data: { cached: false } });
      expect(textOf(retry)).toBe("a complete answer");
    });

    it("should stop the model call and cache nothing when the client disconnects", async () => {
      const id = await addBook();
      llm.state.script = async function* (request, call) {
        if (call > 1) {
          yield "fresh answer";
          return;
        }
        yield "first words";
        await new Promise<void>((resolve) => {
          const stopped = () => {
            llm.state.aborted = true;
            resolve();
          };
          if (request.signal?.aborted) stopped();
          else request.signal?.addEventListener("abort", stopped);
        });
      };

      const response = await send("POST", "/api/ai/explain", explainBody(id));
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await vi.waitFor(() => expect(llm.state.aborted).toBe(true));

      const next = await readSse(await send("POST", "/api/ai/explain", explainBody(id)));
      expect(next.at(-1)).toEqual({ event: "done", data: { cached: false } });
      expect(textOf(next)).toBe("fresh answer");
    });
  });

  describe("chapter aids and ask", () => {
    it("should cache a preview, and regenerate it only when refresh is requested", async () => {
      const id = await addBook();
      llm.state.script = (_request, call) => [`preview v${call}`];
      const ask = (extra: Record<string, unknown> = {}) =>
        send("POST", "/api/ai/chapter", { bookId: id, chapterId: "c1", kind: "preview", lang: "bn", ...extra });

      expect(textOf(await readSse(await ask()))).toBe("preview v1");
      const cached = await readSse(await ask());
      expect(textOf(cached)).toBe("preview v1");
      expect(cached.at(-1)?.data).toEqual({ cached: true });

      const refreshed = await readSse(await ask({ refresh: true }));
      expect(textOf(refreshed)).toBe("preview v2");
      expect(refreshed.at(-1)?.data).toEqual({ cached: false });
      expect(textOf(await readSse(await ask()))).toBe("preview v2");
    });

    it("should send headings as markdown and drop the middle of an overlong chapter", async () => {
      const huge = sampleBook("Huge Book");
      huge.chapters[0]!.blocks.push(
        { id: "c1-b4", type: "paragraph", text: "START-MARK " + "x".repeat(250_000), page: 2 },
        { id: "c1-b5", type: "paragraph", text: "y".repeat(250_000) + " END-MARK", page: 2 },
      );
      const id = await addBook(huge);
      llm.state.script = (request) => [request.user];

      const user = textOf(
        await readSse(await send("POST", "/api/ai/chapter", { bookId: id, chapterId: "c1", kind: "recap", lang: "bn" })),
      );
      expect(user).toContain("## First Chapter\n\nAlpha paragraph has five words.");
      expect(user).toContain("START-MARK");
      expect(user).toContain("END-MARK");
      expect(user).toContain("The middle of this chapter was left out");
      expect(user.length).toBeLessThan(410_000);
    });

    it("should retry an invalid quiz once, accept fenced JSON, and cache the result", async () => {
      const id = await addBook();
      const question = (n: number) => ({ question: `Q${n}?`, options: ["a", "b", "c", "d"], answer: 2, why: "Because." });
      llm.state.script = (_request, call) => {
        if (call === 1) return ["Here is your quiz: not json at all"];
        if (call === 2) return ["```json\n" + JSON.stringify([question(1), question(2)]) + "\n```"];
        return [JSON.stringify([question(9)])];
      };
      const ask = (extra: Record<string, unknown> = {}) =>
        send("POST", "/api/ai/chapter", { bookId: id, chapterId: "c1", kind: "quiz", lang: "bn", ...extra });

      const quiz = await ask();
      expect(quiz.status).toBe(200);
      expect(await quiz.json()).toEqual({ kind: "quiz", questions: [question(1), question(2)] });
      // The cached copy is served without calling the model again.
      expect(await (await ask()).json()).toEqual({ kind: "quiz", questions: [question(1), question(2)] });
      expect(await (await ask({ refresh: true })).json()).toEqual({ kind: "quiz", questions: [question(9)] });
    });

    it("should fail with a clear error when the quiz is still invalid after the retry", async () => {
      const id = await addBook();
      // 3 options and an out-of-range answer are both shape violations.
      llm.state.script = () => [
        JSON.stringify([{ question: "Q?", options: ["a", "b", "c"], answer: 1, why: "w" }]),
      ];
      const bad = await send("POST", "/api/ai/chapter", { bookId: id, chapterId: "c1", kind: "quiz", lang: "bn" });
      expect(bad.status).toBe(502);
      expect(((await bad.json()) as { error: string }).error).toBe("quiz_invalid");

      llm.state.script = () => [JSON.stringify([{ question: "Q?", options: ["a", "b", "c", "d"], answer: 4, why: "w" }])];
      const outOfRange = await send("POST", "/api/ai/chapter", { bookId: id, chapterId: "c1", kind: "quiz", lang: "bn" });
      expect(outOfRange.status).toBe(502);
    });

    it("should answer questions with the conversation so far and never cache them", async () => {
      const id = await addBook();
      llm.state.script = (request, call) => [`#${call} ${request.user}`];
      const ask = () =>
        send("POST", "/api/ai/ask", {
          bookId: id,
          chapterId: "c1",
          question: "Who is Beta?",
          history: [
            { role: "user", text: "What is Alpha?" },
            { role: "assistant", text: "Alpha is first." },
          ],
          lang: "bn",
        });

      const first = await readSse(await ask());
      expect(textOf(first)).toContain("Reader: What is Alpha?\nTutor: Alpha is first.");
      expect(textOf(first)).toContain("Reader's question: Who is Beta?");
      const second = await readSse(await ask());
      expect(textOf(second)).toMatch(/^#2 /);
      expect(second.at(-1)?.data).toEqual({ cached: false });
    });
  });

  describe("request validation", () => {
    it("should reject malformed AI requests with a 4xx ApiError", async () => {
      const id = await addBook();
      const cases: Array<[string, string, unknown, number, string]> = [
        ["/api/ai/explain", "malformed JSON", "{oops", 400, "invalid_request"],
        ["/api/ai/explain", "not an object", "[1]", 400, "invalid_request"],
        ["/api/ai/explain", "unknown mode", explainBody(id, { mode: "shout" }), 400, "invalid_mode"],
        ["/api/ai/explain", "unknown lang", explainBody(id, { lang: "xx" }), 400, "invalid_lang"],
        ["/api/ai/explain", "inherited lang key", explainBody(id, { lang: "constructor" }), 400, "invalid_lang"],
        ["/api/ai/explain", "blank selection", explainBody(id, { selection: "  " }), 400, "invalid_request"],
        ["/api/ai/explain", "missing book", explainBody("nope-12345678"), 404, "book_not_found"],
        ["/api/ai/explain", "missing chapter", explainBody(id, { chapterId: "c9" }), 404, "chapter_not_found"],
        ["/api/ai/explain", "missing block", explainBody(id, { blockId: "c1-b99" }), 404, "block_not_found"],
        ["/api/ai/chapter", "unknown kind", { bookId: id, chapterId: "c1", kind: "poem", lang: "bn" }, 400, "invalid_kind"],
        ["/api/ai/chapter", "bad refresh", { bookId: id, chapterId: "c1", kind: "recap", lang: "bn", refresh: "yes" }, 400, "invalid_request"],
        ["/api/ai/chapter", "unknown lang", { bookId: id, chapterId: "c1", kind: "recap", lang: "zz" }, 400, "invalid_lang"],
        ["/api/ai/ask", "blank question", { bookId: id, chapterId: "c1", question: "", history: [], lang: "bn" }, 400, "invalid_request"],
        ["/api/ai/ask", "bad history role", { bookId: id, chapterId: "c1", question: "Hi?", history: [{ role: "robot", text: "x" }], lang: "bn" }, 400, "invalid_request"],
      ];
      for (const [path, label, body, status, error] of cases) {
        const response = await send("POST", path, body);
        expect(response.status, label).toBe(status);
        const json = (await response.json()) as { error: string; message: string };
        expect(json.error, label).toBe(error);
        expect(json.message.length, label).toBeGreaterThan(10);
      }
      expect(llm.state.calls).toBe(0);
    });

    it("should validate progress bodies against the book", async () => {
      const id = await addBook();
      const put = (body: unknown) => send("PUT", `/api/books/${id}/progress`, body);
      expect((await put({ chapterId: "c1", blockId: "c1-b1" })).status).toBe(200);
      expect((await put({ chapterId: "c9", blockId: "c1-b1" })).status).toBe(404);
      expect((await put({ chapterId: "c1", blockId: "c2-b1" })).status).toBe(404);
      expect((await put({ chapterId: "c1" })).status).toBe(400);
      expect((await put("{oops")).status).toBe(400);
    });
  });

  describe("quick translate", () => {
    it("should return the translation, and a 502 ApiError when the service fails", async () => {
      const ok = await app.request("/api/translate?q=ubiquitous&lang=bn");
      expect(await ok.json()).toEqual({ text: "ubiquitous", translation: "bn:ubiquitous", lang: "bn" });

      const down = await app.request("/api/translate?q=boom&lang=bn");
      expect(down.status).toBe(502);
      expect(((await down.json()) as { error: string }).error).toBe("translate_unavailable");
    });

    it("should reject missing text, unknown languages and text over 200 characters", async () => {
      expect((await app.request("/api/translate?lang=bn")).status).toBe(400);
      expect((await app.request("/api/translate?q=hello&lang=xx")).status).toBe(400);
      expect((await app.request(`/api/translate?q=${"a".repeat(201)}&lang=bn`)).status).toBe(400);
      expect((await app.request(`/api/translate?q=${"a".repeat(200)}&lang=bn`)).status).toBe(200);
    });
  });

  it("should refuse requests that come from another website or a non-local host name", async () => {
    const fromOtherSite = await app.request("/api/books", { method: "POST", headers: { origin: "https://evil.example" }, body: new FormData() });
    expect(fromOtherSite.status).toBe(403);
    expect(((await fromOtherSite.json()) as { error: string }).error).toBe("forbidden_origin");
    expect((await app.request("/api/health", { headers: { origin: "null" } })).status).toBe(403);
    expect((await app.request("http://evil.example/api/health")).status).toBe(403);

    // The dev server (another port) and plain tools such as curl (no Origin) are fine.
    expect((await app.request("/api/health", { headers: { origin: "http://localhost:5173" } })).status).toBe(200);
    expect((await app.request("http://127.0.0.1:8787/api/health", { headers: { origin: "http://127.0.0.1:8787" } })).status).toBe(200);
  });

  it("should answer unknown API paths with a JSON 404 and report health", async () => {
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true });
    const missing = await app.request("/api/nothing-here");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("not_found");
  });

  describe("remote access through a tunnel", () => {
    const KEY = "k3y-for-tests-0123456789";
    const TUNNEL = "https://quiet-river.trycloudflare.com";
    // What a tunnelled request really looks like here: cloudflared and the Vite proxy rewrite Host to
    // loopback, and Cloudflare's edge adds cf-connecting-ip and cf-ray.
    const viaTunnel = { "cf-connecting-ip": "203.0.113.7", "cf-ray": "8f0c1a2b3c4d5e6f-DAC" };
    let remote: Hono;

    beforeEach(() => {
      remote = createApp({
        dataDir,
        parsePdf: fakeParsePdf,
        llm: llm.llm,
        quickTranslate: async (text) => text,
        remoteKey: KEY,
      });
    });

    const unlockCookie = async (): Promise<string> => {
      const unlocked = await remote.request(`/api/unlock?key=${KEY}`, { headers: viaTunnel });
      return (unlocked.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    };

    it("should refuse a tunnelled request when the device has not been unlocked with the key", async () => {
      const response = await remote.request("/api/books", { headers: viaTunnel });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe("locked");
      expect((await remote.request("/api/unlock?key=wrong-key", { headers: viaTunnel })).status).toBe(403);
      // A host name that is not this computer counts as remote too (production serving without a proxy).
      expect((await remote.request(`${TUNNEL}/api/books`)).status).toBe(403);
    });

    it("should unlock a device with the key link and then answer its same-origin requests", async () => {
      const unlocked = await remote.request(`/api/unlock?key=${KEY}`, { headers: { ...viaTunnel, "sec-fetch-site": "none" } });
      expect(unlocked.status).toBe(302);
      expect(unlocked.headers.get("location")).toBe("/");
      const setCookie = unlocked.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      expect(setCookie).toMatch(/Secure/i);
      expect(setCookie).not.toMatch(/Domain=/i);

      const cookie = await unlockCookie();
      const headers = { ...viaTunnel, cookie, origin: TUNNEL, "sec-fetch-site": "same-origin" };
      expect((await remote.request("/api/books", { headers })).status).toBe(200);
    });

    it("should refuse another website even when the device is unlocked", async () => {
      const cookie = await unlockCookie();
      for (const site of ["cross-site", "same-site"]) {
        const borrowed = await remote.request("/api/books", {
          method: "POST",
          headers: { ...viaTunnel, cookie, origin: "https://evil.trycloudflare.com", "sec-fetch-site": site },
          body: new FormData(),
        });
        expect(borrowed.status).toBe(403);
      }
    });

    it("should keep this computer working without any key", async () => {
      expect((await remote.request("/api/health", { headers: { origin: "http://localhost:5173" } })).status).toBe(200);
    });

    it("should refuse all tunnelled requests when no key is configured", async () => {
      expect((await app.request("/api/books", { headers: viaTunnel })).status).toBe(403);
      expect((await app.request(`/api/unlock?key=${KEY}`, { headers: viaTunnel })).status).toBe(403);
      expect((await app.request(`/api/unlock?key=${KEY}`)).status).toBe(404);
    });
  });
});
