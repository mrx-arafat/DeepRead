import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { BookUpdate, Note, ParsedBook, ReadingProgress } from "../shared/types.ts";
import type { AppEnv } from "./app-env.ts";
import type { ParsePdf, RenderCover } from "./deps.ts";
import {
  apiError,
  blockNotFound,
  bookNotFound,
  chapterNotFound,
  invalidBody,
  invalidId,
  isExplainMode,
  isLangCode,
  isRecord,
  readJsonObject,
  readString,
} from "./http.ts";
import { isBookId, StorageFullError } from "./library.ts";
import type { StoredPdf } from "./library.ts";
import { ParseError } from "./parser/errors.ts";
import { titleFromFileName } from "./upload-name.ts";

export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
// Multipart framing adds a little to the file itself; the exact file size is checked after parsing.
const MULTIPART_SLACK_BYTES = 1024 * 1024;
const PDF_MAGIC = "%PDF-";
const MAX_ID_FIELD = 200;
// Counted in UTF-16 units, the same way the edit form's maxLength counts, so the form never allows what the server refuses.
const MAX_TITLE_CHARS = 200;
const MAX_AUTHOR_CHARS = 120;
// The longest passage the reader can ask about (routes-ai.ts takes the same).
const MAX_QUOTE_CHARS = 5_000;

/** Checks a PATCH body field by field; the Response is the 400 to send instead. */
function readBookUpdate(c: Context, body: Record<string, unknown>): BookUpdate | Response {
  const update: BookUpdate = {};

  if (Object.hasOwn(body, "title")) {
    const { title } = body;
    if (typeof title !== "string") return apiError(c, 400, "invalid_title", "The title must be text.");
    const trimmed = title.trim();
    if (trimmed === "") return apiError(c, 400, "invalid_title", "The title cannot be empty. Type a title for this book.");
    if (trimmed.length > MAX_TITLE_CHARS) {
      return apiError(c, 400, "invalid_title", `The title is too long. Keep it to ${MAX_TITLE_CHARS} characters or fewer.`);
    }
    update.title = trimmed;
  }

  if (Object.hasOwn(body, "author")) {
    const { author } = body;
    if (author !== null && typeof author !== "string") {
      return apiError(c, 400, "invalid_author", "The author must be text, or empty to remove it.");
    }
    const trimmed = author?.trim() ?? "";
    if (trimmed.length > MAX_AUTHOR_CHARS) {
      return apiError(c, 400, "invalid_author", `The author is too long. Keep it to ${MAX_AUTHOR_CHARS} characters or fewer.`);
    }
    update.author = trimmed === "" ? null : trimmed;
  }

  if (update.title === undefined && update.author === undefined) {
    return apiError(c, 400, "invalid_request", "Nothing to change. Send a new title, a new author, or both.");
  }
  return update;
}

/** Streams the upload to disk while hashing it, so a big PDF is never copied around in memory twice. */
async function saveUpload(file: File, destination: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(file.stream() as unknown as NodeReadableStream),
    async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destination),
  );
  return hash.digest("hex");
}

/** A note in a request body, or null when it is not one. */
function readNote(value: unknown): Note | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id", MAX_ID_FIELD);
  const chapterId = readString(value, "chapterId", MAX_ID_FIELD);
  const blockId = readString(value, "blockId", MAX_ID_FIELD);
  const { quote, mode, lang } = value;
  if (!id || !chapterId || !blockId || typeof quote !== "string" || quote.length > MAX_QUOTE_CHARS) return null;
  if (!isExplainMode(mode) || !isLangCode(lang)) return null;
  return { id, chapterId, blockId, quote, mode, lang };
}

const storageFull = (c: Context, error: StorageFullError): Response => apiError(c, 507, "storage_full", error.message);

type ByteRange = { start: number; end: number };

/** "unsatisfiable" is a valid range that lies outside the file; null means no usable Range header. */
function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  // Multi-range requests and malformed headers are ignored, which the HTTP spec allows: we send the whole file.
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const [, first = "", last = ""] = match;
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0 ? "unsatisfiable" : { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}

async function sendPdf(c: Context, pdf: StoredPdf): Promise<Response> {
  const { size } = pdf;
  const headers = {
    "Content-Type": "application/pdf",
    "Accept-Ranges": "bytes",
    // The id contains a hash of the file, so the bytes behind one URL never change.
    "Cache-Control": "private, max-age=86400",
  };
  const range = parseRange(c.req.header("range"), size);
  if (range === "unsatisfiable") {
    return c.body(null, 416, { ...headers, "Content-Range": `bytes */${size}` });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const partial = {
    ...headers,
    "Content-Length": String(end - start + 1),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  };
  const status = range ? 206 : 200;
  if (c.req.method === "HEAD") return c.body(null, status, partial);
  const body = await pdf.stream({ start, end });
  // Removed since its size was looked up.
  if (!body) return bookNotFound(c);
  // The reader went away while it was being opened: nothing will read it, so it must not hold the file or connection.
  if (c.req.raw.signal.aborted) {
    await body.cancel();
    // 499, "client closed request": nobody is there to read it.
    return new Response(null, { status: 499 });
  }
  return c.body(body, status, partial);
}

/** The books of whoever is reading: every route works on c.var.library. */
export function booksRoutes(deps: { parsePdf: ParsePdf; renderCover: RenderCover }): Hono<AppEnv> {
  const { parsePdf, renderCover } = deps;
  const routes = new Hono<AppEnv>();

  routes.get("/", async (c) => c.json(await c.var.library.list()));

  routes.post(
    "/",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + MULTIPART_SLACK_BYTES,
      onError: (c) => apiError(c, 413, "too_large", "This PDF is larger than 300 MB. Try a smaller file."),
    }),
    async (c) => {
      const { library } = c.var;
      // SHORTCUT: Hono parses the multipart body in memory (bounded by the 300 MB cap); move to a streaming parser if uploads that large become routine.
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        return apiError(c, 400, "invalid_upload", "The upload could not be read. Choose the PDF again and retry.");
      }
      const file = form["file"];
      if (!(file instanceof File)) {
        return apiError(c, 400, "missing_file", "No file was attached. Choose a PDF and try again.");
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return apiError(c, 413, "too_large", "This PDF is larger than 300 MB. Try a smaller file.");
      }
      // The name and declared type come from the browser; only the bytes say what the file is.
      const head = Buffer.from(await file.slice(0, PDF_MAGIC.length).arrayBuffer()).toString("latin1");
      if (head !== PDF_MAGIC) {
        return apiError(c, 415, "not_pdf", "That file is not a PDF. Choose a file that ends in .pdf.");
      }

      const uploadPath = await library.newUploadPath(titleFromFileName(file.name));
      try {
        const sha256 = await saveUpload(file, uploadPath);

        const existingId = await library.findBySha(sha256);
        if (existingId) {
          const existing = await library.detail(existingId);
          if (existing) return c.json(existing, 200);
        }
        // Before parsing, which can take a minute for a long book: a library with no room says so at once.
        await library.assertRoom(file.size);

        // Drawn while the book is parsed, each in a thread of its own, so looking for the cover adds nothing to the wait.
        // It never rejects, so a parse that fails can leave it to finish on its own.
        const cover = renderCover(uploadPath);
        let parsed: ParsedBook;
        try {
          parsed = await parsePdf(uploadPath);
        } catch (error) {
          if (error instanceof ParseError) return apiError(c, 422, error.kind, error.message);
          console.error("PDF parsing failed unexpectedly:", error);
          return apiError(c, 500, "parse_failed", "This PDF could not be read because of an unexpected problem. Try again, or use a different copy of the book.");
        }

        const { id, created } = await library.add({ uploadPath, sha256, parsed, cover: await cover });
        const detail = await library.detail(id);
        if (!detail) throw new Error(`book ${id} vanished right after it was added`);
        return c.json(detail, created ? 201 : 200);
      } catch (error) {
        if (error instanceof StorageFullError) return storageFull(c, error);
        throw error;
      } finally {
        // The upload is moved into the library on success; this removes what is left of it on every path.
        await library.discardUpload(uploadPath);
      }
    },
  );

  routes.get("/:id", async (c) => {
    const { library } = c.var;
    const id = c.req.param("id");
    if (!isBookId(id)) return invalidId(c);
    const detail = await library.detail(id);
    return detail ? c.json(detail) : bookNotFound(c);
  });

  routes.patch(
    "/:id",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => invalidBody(c, "the body is too large."),
    }),
    async (c) => {
      const { library } = c.var;
      const id = c.req.param("id");
      if (!isBookId(id)) return invalidId(c);
      const body = await readJsonObject(c);
      if (!body) return invalidBody(c, "send JSON like {\"title\": \"...\", \"author\": \"...\"}.");
      const update = readBookUpdate(c, body);
      if (update instanceof Response) return update;

      if (!(await library.update(id, update))) return bookNotFound(c);
      const detail = await library.detail(id);
      return detail ? c.json(detail) : bookNotFound(c);
    },
  );

  routes.delete("/:id", async (c) => {
    const { library } = c.var;
    const id = c.req.param("id");
    if (!isBookId(id)) return invalidId(c);
    return (await library.remove(id)) ? c.body(null, 204) : bookNotFound(c);
  });

  routes.get("/:id/chapters/:chapterId", async (c) => {
    const { library } = c.var;
    const id = c.req.param("id");
    if (!isBookId(id)) return invalidId(c);
    const book = await library.book(id);
    if (!book) return bookNotFound(c);
    const chapter = book.chapters.find((candidate) => candidate.id === c.req.param("chapterId"));
    return chapter ? c.json(chapter) : chapterNotFound(c);
  });

  routes.get("/:id/pdf", async (c) => {
    const { library } = c.var;
    const id = c.req.param("id");
    if (!isBookId(id)) return invalidId(c);
    const pdf = await library.pdf(id);
    return pdf ? sendPdf(c, pdf) : bookNotFound(c);
  });

  routes.get("/:id/cover", async (c) => {
    const { library } = c.var;
    const id = c.req.param("id");
    if (!isBookId(id)) return invalidId(c);
    const cover = await library.cover(id);
    if (!cover) return apiError(c, 404, "cover_not_found", "This book has no cover of its own.");
    const headers = {
      "Content-Type": cover.type,
      // The cover is drawn once from the PDF, and the id contains a hash of that file, so it hardly ever changes.
      "Cache-Control": "private, max-age=86400",
      ETag: `"${createHash("sha256").update(cover.data).digest("base64url").slice(0, 27)}"`,
    };
    if (c.req.header("if-none-match") === headers.ETag) return c.body(null, 304, headers);
    return c.body(cover.data, 200, headers);
  });

  routes.get("/:id/notes", async (c) => {
    const { library } = c.var;
    const id = c.req.param("id");
    if (!isBookId(id)) return invalidId(c);
    const notes = await library.notes(id);
    return notes ? c.json(notes) : bookNotFound(c);
  });

  // One note at a time, never the whole list: a list sent from one device would wipe notes added on another.
  routes.put(
    "/:id/notes/:noteId",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => invalidBody(c, "the body is too large."),
    }),
    async (c) => {
      const { library } = c.var;
      const id = c.req.param("id");
      if (!isBookId(id)) return invalidId(c);
      const body = await readJsonObject(c);
      const note = body && readNote(body.note);
      const before = body?.before ?? null;
      if (!note || note.id !== c.req.param("noteId") || (before !== null && typeof before !== "string")) {
        return invalidBody(c, "send JSON like {\"note\": {...}, \"before\": null}, with the note's id in the address.");
      }
      return (await library.changeNotes(id, { kind: "put", note, before })) ? c.body(null, 204) : bookNotFound(c);
    },
  );

  routes.delete("/:id/notes/:noteId", async (c) => {
    const { library } = c.var;
    const id = c.req.param("id");
    if (!isBookId(id)) return invalidId(c);
    const noteId = c.req.param("noteId");
    if (noteId.length > MAX_ID_FIELD) return invalidBody(c, "that note id is too long.");
    return (await library.changeNotes(id, { kind: "remove", id: noteId })) ? c.body(null, 204) : bookNotFound(c);
  });

  routes.put(
    "/:id/progress",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => invalidBody(c, "the body is too large."),
    }),
    async (c) => {
      const { library } = c.var;
      const id = c.req.param("id");
      if (!isBookId(id)) return invalidId(c);
      const body = await readJsonObject(c);
      const chapterId = body && readString(body, "chapterId", MAX_ID_FIELD);
      const blockId = body && readString(body, "blockId", MAX_ID_FIELD);
      if (!chapterId || !blockId) return invalidBody(c, "send JSON like {\"chapterId\": \"...\", \"blockId\": \"...\"}.");
      // A reader from before lines were kept sends only the block: its start.
      const offset = body?.offset ?? 0;
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
        return invalidBody(c, "offset must be a whole number of characters into the paragraph.");
      }

      const book = await library.book(id);
      if (!book) return bookNotFound(c);
      const chapter = book.chapters.find((candidate) => candidate.id === chapterId);
      if (!chapter) return chapterNotFound(c);
      const block = chapter.blocks.find((candidate) => candidate.id === blockId);
      if (!block) return blockNotFound(c);
      if (offset > block.text.length) return invalidBody(c, "offset is past the end of that paragraph.");

      const progress: ReadingProgress | null = await library.setProgress(id, chapterId, blockId, offset);
      if (progress) return c.json(progress);
      // The book was there a moment ago: null means the block holds no reading position (a heading), unless it just went.
      return (await library.book(id)) ? blockNotFound(c) : bookNotFound(c);
    },
  );

  return routes;
}
