// Functional test of who may take a book's PDF away: its owner can, while a profile it is shared with reads every word
// of it in DeepRead but never gets the owner's file. Real routes and disk storage in a temp dir, fake parser and model.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminProfile, ApiError, BookSummary, Chapter, ParsedBook, PublicProfile } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import type { AppEnv } from "./app-env.ts";
import { createApp } from "./app.ts";
import type { ParsePdf } from "./deps.ts";
import { createProfiles } from "./profiles.ts";
import type { Profiles } from "./profiles.ts";
import { sessionKey } from "./session-token.ts";
import { loadSessionSecret } from "./sessions.ts";
import { createLocalStore } from "./storage.ts";

const PASSKEY = "a long admin passkey for tests, ".repeat(3);

const book = (title: string): ParsedBook => ({
  title,
  author: null,
  pageCount: 1,
  warnings: [],
  chapters: [{ id: "c1", title: "One", startPage: 1, endPage: 1, blocks: [{ id: "c1-b0", type: "paragraph", text: `${title} text.`, page: 1 }] }],
});
// The fake parser reads the uploaded file from disk, so these bytes stand in for a real PDF.
const pdfBytes = (title: string): string => `%PDF-1.4\n${JSON.stringify(book(title))}\n`;
const fakeParsePdf: ParsePdf = async (path) => JSON.parse((await readFile(path, "utf8")).split("\n")[1] ?? "") as ParsedBook;
const fakeLlm: Ai = {
  streamText: () =>
    (async function* () {
      yield "An answer.";
    })(),
  model: () => "fake-model",
  status: async () => ({ active: null, providers: [] }),
  ensureStatus: async () => {},
  statusFor: async () => ({ active: null, providers: [] }),
  for: () => fakeLlm,
  choose: async () => ({ active: null, providers: [] }),
  close() {},
};

const cookieFrom = (response: Response): string => (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

describe("the PDF of a shared book", () => {
  let dataDir: string;
  let app: Hono<AppEnv>;
  let profiles: Profiles;
  let admin: string;

  const call = (method: string, path: string, cookie = "", body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(cookie && { cookie }), ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }) },
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
    });
  const json = async <T>(response: Response | Promise<Response>): Promise<T> => (await (await response).json()) as T;

  async function signIn(profileId: string, code: string): Promise<string> {
    const response = await call("POST", "/api/session", "", { profileId, code });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }
  async function addProfile(adminCookie: string, name: string, code: string): Promise<AdminProfile> {
    const response = await call("POST", "/api/admin/profiles", adminCookie, { name, code, preset: "cat-rose" });
    expect(response.status).toBe(201);
    return json<AdminProfile>(response);
  }
  async function upload(cookie: string, title: string): Promise<string> {
    const form = new FormData();
    form.set("file", new File([pdfBytes(title)], `${title}.pdf`, { type: "application/pdf" }));
    const response = await call("POST", "/api/books", cookie, form);
    expect(response.status).toBe(201);
    return (await json<BookSummary>(response)).id;
  }
  /** Rafi's book, shared with Mina: the id it goes by on her shelf, and everyone's cookies. */
  async function sharedFromRafiToMina(title: string) {
    const adminCookie = await signIn(admin, PASSKEY);
    const rafi = await addProfile(adminCookie, "Rafi", "135790");
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const rafiCookie = await signIn(rafi.id, "135790");
    const minaCookie = await signIn(mina.id, "246810");
    const bookId = await upload(rafiCookie, title);
    expect((await call("PUT", `/api/books/${bookId}/shares/${mina.id}`, rafiCookie)).status).toBe(204);
    const sharedId = (await json<BookSummary[]>(call("GET", "/api/books", minaCookie)))[0]!.id;
    return { adminCookie, rafi, mina, rafiCookie, minaCookie, bookId, sharedId };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-shared-pdf-"));
    profiles = createProfiles({ store: createLocalStore(dataDir), dataDir, limit: null, adminPasskey: PASSKEY, adminName: "Arafat" });
    app = createApp({
      accounts: { profiles, sessionKey: sessionKey(await loadSessionSecret(dataDir), PASSKEY) },
      parsePdf: fakeParsePdf,
      renderCover: async () => null,
      llm: fakeLlm,
      quickTranslate: async (text) => text,
    });
    admin = (await json<PublicProfile[]>(call("GET", "/api/profiles")))[0]!.id;
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("should give the owner their PDF, and the reader it is shared with every word of it but not the file", async () => {
    const { mina, rafiCookie, minaCookie, bookId, sharedId } = await sharedFromRafiToMina("Kokoro");

    const own = await call("GET", `/api/books/${bookId}/pdf`, rafiCookie);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe(pdfBytes("Kokoro"));

    const refused = await call("GET", `/api/books/${sharedId}/pdf`, minaCookie);
    expect(refused.status).toBe(403);
    expect(await json<ApiError>(refused)).toEqual({
      error: "shared_pdf_owner_only",
      message: "Rafi shared this book with you to read here. The PDF file itself stays with them.",
    });
    // Nor from the shelf itself, for any caller other than the route.
    expect(await profiles.shelf(mina.id).pdf(sharedId)).toBeNull();

    // The reading is the point of sharing, and stays.
    const chapter = await call("GET", `/api/books/${sharedId}/chapters/c1`, minaCookie);
    expect(chapter.status).toBe(200);
    expect((await json<Chapter>(chapter)).blocks[0]?.text).toBe("Kokoro text.");

    // Once the share stops, the book is not on her shelf at all.
    expect((await call("DELETE", `/api/books/${bookId}/shares/${mina.id}`, rafiCookie)).status).toBe(204);
    const gone = await call("GET", `/api/books/${sharedId}/pdf`, minaCookie);
    expect(gone.status).toBe(404);
    expect(await json<ApiError>(gone)).toMatchObject({ error: "book_not_found" });
  });

  it("should show the admin reading as someone just what that someone gets, and the owner's PDF when reading as the owner", async () => {
    const { adminCookie, rafi, mina, bookId, sharedId } = await sharedFromRafiToMina("Kokoro");

    const asMina = cookieFrom(await call("POST", `/api/admin/impersonate/${mina.id}`, adminCookie));
    expect((await call("GET", `/api/books/${sharedId}/chapters/c1`, asMina)).status).toBe(200);
    const refused = await call("GET", `/api/books/${sharedId}/pdf`, asMina);
    expect(refused.status).toBe(403);
    expect(await json<ApiError>(refused)).toMatchObject({ error: "shared_pdf_owner_only" });

    const asRafi = cookieFrom(await call("POST", `/api/admin/impersonate/${rafi.id}`, adminCookie));
    const own = await call("GET", `/api/books/${bookId}/pdf`, asRafi);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe(pdfBytes("Kokoro"));
  });
});
