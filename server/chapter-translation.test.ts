// Chapter translation with an injected fetch, so nothing touches the network: the services' answers are shaped like the
// ones Microsoft's and Google's endpoints gave. The routes run through createApp on real disk storage in a temp dir.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, BookSummary, Chapter, ChapterTranslation, ParsedBook, PublicProfile, TranslationSettings, TranslationTest } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import { createApp } from "./app.ts";
import { createChapterTranslator, createTranslationSettings, TRANSLATION_SAMPLE, TranslationError, translateTexts } from "./chapter-translation.ts";
import type { ParsePdf } from "./deps.ts";
import { createLibrary } from "./library.ts";
import type { Library } from "./library.ts";
import { createProfiles } from "./profiles.ts";
import type { Profiles } from "./profiles.ts";
import { sessionKey } from "./session-token.ts";
import { loadSessionSecret } from "./sessions.ts";
import { createLocalStore } from "./storage.ts";

type Answer = Response | Promise<Response>;

/**
 * Both services, answering as they do: Microsoft with "ms:<text>" for each string it is sent, Google with "g:<text>" in
 * two pieces, the way it cuts its answer at sentences. `microsoft` and `google` answer instead when given.
 */
function services(answers: { microsoft?: (texts: string[], init?: RequestInit) => Answer; google?: (text: string, init?: RequestInit) => Answer } = {}) {
  const calls: Array<{ service: "microsoft" | "google"; texts: string[]; url: URL; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin === "https://edge.microsoft.com" && url.pathname === "/translate/translatetext") {
      const texts = JSON.parse(String(init?.body)) as string[];
      calls.push({ service: "microsoft", texts, url, init });
      return answers.microsoft?.(texts, init) ?? Response.json(texts.map((text) => ({ translations: [{ text: `ms:${text}`, to: url.searchParams.get("to") }] })));
    }
    if (url.origin === "https://translate.googleapis.com" && url.pathname === "/translate_a/single") {
      const text = url.searchParams.get("q") ?? "";
      calls.push({ service: "google", texts: [text], url, init });
      const half = Math.ceil(text.length / 2);
      return answers.google?.(text, init) ?? Response.json([[[`g:${text.slice(0, half)}`, text.slice(0, half), null, null, 10], [text.slice(half), text.slice(half), null, null, 10]], null, "en"]);
    }
    throw new Error(`unexpected request to ${url.href}`);
  };
  return { fetchImpl, calls };
}

/** A service that never answers, until the request's timeout gives up on it. */
const hang = (init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

/** What Google sends from an address it suspects: a redirect to its robot check. */
const robotCheck = (): Response => new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index?continue=x" } });

const chapter = (texts: string[]): Chapter => ({
  id: "c1",
  title: "One",
  startPage: 1,
  endPage: 1,
  blocks: texts.map((text, at) => ({ id: `c1-b${at}`, type: at === 0 ? "heading" : "paragraph", ...(at === 0 && { level: 1 as const }), text, page: 1 })),
});

const book = (title: string, texts: string[]): ParsedBook => ({ title, author: null, pageCount: 1, warnings: [], chapters: [chapter(texts)] });

const TEXTS = ["The Problem", "Appearance and reality.", "The table looks brown.", "", "We will call it a physical object."];

describe("translateTexts", () => {
  it("should send Microsoft at most 100 strings and about 40,000 characters a request, and keep their order", async () => {
    const { fetchImpl, calls } = services();
    const many = Array.from({ length: 150 }, (_, at) => `Paragraph ${at}.`);
    expect(await translateTexts(many, "bn", "microsoft", { fetchImpl })).toEqual(many.map((text) => ({ text: `ms:${text}`, engine: "microsoft" })));
    expect(calls.map((call) => call.texts.length)).toEqual([100, 50]);
    expect(calls[0]?.url.searchParams.get("from")).toBe("en");
    expect(calls[0]?.url.searchParams.get("to")).toBe("bn");
    expect(calls[0]?.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });

    calls.length = 0;
    const long = Array.from({ length: 5 }, (_, at) => `${at}`.repeat(15_000));
    expect((await translateTexts(long, "fr", "microsoft", { fetchImpl })).map((made) => made.text)).toEqual(long.map((text) => `ms:${text}`));
    expect(calls.map((call) => call.texts.length)).toEqual([2, 2, 1]);
  });

  it("should send Google a paragraph at a time, cutting a long one at sentence ends, and join its pieces", async () => {
    const { fetchImpl, calls } = services();
    const sentences = Array.from({ length: 300 }, (_, at) => `Sentence number ${at} says something about the table.`);
    const long = sentences.join(" ");
    const made = await translateTexts(["A short one.", long], "es", "google", { fetchImpl });

    expect(made[0]).toEqual({ text: "g:A short one.", engine: "google" });
    const pieces = calls.slice(1).map((call) => call.texts[0] ?? "");
    expect(pieces.length).toBeGreaterThan(3);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(4_500);
      expect(sentences).toContain(piece.slice(piece.lastIndexOf("Sentence number")));
    }
    expect(pieces.join(" ")).toBe(long);
    expect(made[1]?.text).toBe(pieces.map((piece) => `g:${piece}`).join(" "));
    expect(calls[0]?.url.searchParams.get("tl")).toBe("es");
    expect(calls[0]?.url.searchParams.get("sl")).toBe("en");
  });

  it("should take Google's robot check, a web page or a service that hangs for a failure, never for a translation", async () => {
    const failing = [
      services({ google: robotCheck }).fetchImpl,
      services({ google: () => new Response("<html><body>Our systems have detected unusual traffic</body></html>", { headers: { "content-type": "text/html" } }) }).fetchImpl,
      services({ google: () => Response.json([null, null, "en"]) }).fetchImpl,
      services({ google: (_text, init) => hang(init) }).fetchImpl,
    ];
    for (const fetchImpl of failing) {
      await expect(translateTexts(["Hello."], "tr", "google", { fetchImpl, timeoutMs: 50 })).rejects.toBeInstanceOf(TranslationError);
    }
    await expect(translateTexts(["Hello."], "tr", "google", { fetchImpl: failing[0] })).rejects.toThrow(/Google answered 302/);
  });

  it("should fall back to Google for a batch Microsoft cannot translate when the engine is auto, and fail only when both cannot", async () => {
    const busy = (): Response => new Response("busy", { status: 503 });
    for (const microsoft of [busy, (_texts: string[], init?: RequestInit) => hang(init)]) {
      const { fetchImpl, calls } = services({ microsoft });
      expect(await translateTexts(["Hello.", "World."], "ar", "auto", { fetchImpl, timeoutMs: 50 })).toEqual([
        { text: "g:Hello.", engine: "google" },
        { text: "g:World.", engine: "google" },
      ]);
      expect(calls.map((call) => call.service)).toEqual(["microsoft", "google", "google"]);
      // Chosen alone, Microsoft's failure is the answer.
      await expect(translateTexts(["Hello."], "ar", "microsoft", { fetchImpl, timeoutMs: 50 })).rejects.toBeInstanceOf(TranslationError);
    }
    const { fetchImpl } = services({ microsoft: () => new Response("busy", { status: 503 }), google: robotCheck });
    await expect(translateTexts(["Hello."], "ar", "auto", { fetchImpl })).rejects.toThrow(/Microsoft answered 503.*Google answered 302/);
  });
});

describe("createChapterTranslator", () => {
  let dataDir: string;
  let library: Library;
  let bookId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-chapter-translation-"));
    library = createLibrary(dataDir);
    const uploadPath = await library.newUploadPath("book");
    await writeFile(uploadPath, "%PDF-1.4");
    ({ id: bookId } = await library.add({ uploadPath, sha256: "ab".repeat(32), parsed: book("Problems", TEXTS), cover: null }));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("should translate a chapter once, keep it with the book, and translate again only a block whose text changed", async () => {
    const { fetchImpl, calls } = services();
    const first = await createChapterTranslator({ fetchImpl }).chapter({ library, bookId }, chapter(TEXTS), "bn", "auto");
    expect(first).toEqual({
      lang: "bn",
      engine: "microsoft",
      blocks: { "c1-b0": "ms:The Problem", "c1-b1": "ms:Appearance and reality.", "c1-b2": "ms:The table looks brown.", "c1-b4": "ms:We will call it a physical object." },
    });
    // The blank block is never sent.
    expect(calls.map((call) => call.texts)).toEqual([TEXTS.filter((text) => text !== "")]);

    // DeepRead starting again: the translation is read from the book, not made again.
    const restarted = createChapterTranslator({ fetchImpl });
    expect(await restarted.chapter({ library: createLibrary(dataDir), bookId }, chapter(TEXTS), "bn", "auto")).toEqual(first);
    expect(calls).toHaveLength(1);

    // The book parsed again, with one paragraph read differently: only that one is translated again.
    const reparsed = TEXTS.map((text, at) => (at === 2 ? "The table looks reddish brown." : text));
    const again = await restarted.chapter({ library, bookId }, chapter(reparsed), "bn", "auto");
    expect(again.blocks["c1-b2"]).toBe("ms:The table looks reddish brown.");
    expect(again.blocks["c1-b1"]).toBe(first.blocks["c1-b1"]);
    expect(calls.slice(1).map((call) => call.texts)).toEqual([["The table looks reddish brown."]]);

    // Another language is another translation.
    await restarted.chapter({ library, bookId }, chapter(TEXTS), "hi", "auto");
    expect(calls).toHaveLength(3);
  });

  it("should translate a chapter once when two readers open it at the same moment", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { fetchImpl, calls } = services({
      microsoft: async (texts) => {
        await held;
        return Response.json(texts.map((text) => ({ translations: [{ text: `ms:${text}` }] })));
      },
    });
    const translator = createChapterTranslator({ fetchImpl });
    const both = Promise.all([
      translator.chapter({ library, bookId }, chapter(TEXTS), "ur", "auto"),
      translator.chapter({ library, bookId }, chapter(TEXTS), "ur", "auto"),
    ]);
    release();
    const [one, other] = await both;
    expect(one).toEqual(other);
    expect(calls).toHaveLength(1);
  });

  it("should say which service made most of a chapter, and keep nothing when no service can translate it", async () => {
    const { fetchImpl } = services({ microsoft: () => new Response("busy", { status: 503 }) });
    expect((await createChapterTranslator({ fetchImpl }).chapter({ library, bookId }, chapter(TEXTS), "id", "auto")).engine).toBe("google");

    const down = services({ microsoft: () => new Response("busy", { status: 503 }), google: robotCheck });
    await expect(createChapterTranslator({ fetchImpl: down.fetchImpl }).chapter({ library, bookId }, chapter(TEXTS), "tr", "auto")).rejects.toBeInstanceOf(
      TranslationError,
    );
    expect(await library.readTranslation(bookId, "tr", "c1")).toBeNull();
  });
});

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

// The fake parser reads the uploaded file from disk, so these bytes stand in for a real PDF.
const pdfBytes = (parsed: ParsedBook): string => `%PDF-1.4\n${JSON.stringify(parsed)}`;
const fakeParsePdf: ParsePdf = async (path) => JSON.parse((await readFile(path, "utf8")).split("\n")[1] ?? "") as ParsedBook;

describe("chapter translation over HTTP", () => {
  const PASSKEY = "a long admin passkey for translation tests";
  let dataDir: string;
  // What the services answer instead of translating: a test sets a field to make one fail. The fake reads it on every request.
  let answers: NonNullable<Parameters<typeof services>[0]>;
  let net: ReturnType<typeof services>;
  let started: Profiles[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-translation-app-"));
    answers = {};
    net = services(answers);
    started = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    // Signing in saves the locks without waiting for them.
    await Promise.all(started.map((profiles) => profiles.flush()));
    await rm(dataDir, { recursive: true, force: true });
  });

  const translation = () => ({ settings: createTranslationSettings(dataDir), translator: createChapterTranslator({ fetchImpl: net.fetchImpl }) });
  const fakes = { parsePdf: fakeParsePdf, renderCover: async () => null, llm: fakeLlm, quickTranslate: async (text: string) => text };
  type Call = (method: string, path: string, cookie?: string, body?: unknown) => Response | Promise<Response>;

  /** DeepRead with profiles (ADMIN_PASSKEY set), starting (again) on the data folder: a request to it, sending `cookie`. */
  async function start(): Promise<Call> {
    const profiles = createProfiles({ store: createLocalStore(dataDir), dataDir, limit: null, adminPasskey: PASSKEY, adminName: "Arafat" });
    started.push(profiles);
    const app = createApp({ ...fakes, accounts: { profiles, sessionKey: sessionKey(await loadSessionSecret(dataDir), PASSKEY) }, translation: translation() });
    return (method, path, cookie = "", body) =>
      app.request(path, {
        method,
        headers: { ...(cookie && { cookie }), ...(body !== undefined && !(body instanceof FormData) && { "content-type": "application/json" }) },
        body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
      });
  }

  /** The admin and a reader, Mina, signed in: their ids and session cookies. */
  async function signedIn(call: Call) {
    const signIn = async (profileId: string, code: string): Promise<string> => {
      const response = await call("POST", "/api/session", "", { profileId, code });
      expect(response.status).toBe(200);
      return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    };
    const adminId = (((await (await call("GET", "/api/profiles")).json()) as PublicProfile[])[0] as PublicProfile).id;
    const admin = await signIn(adminId, PASSKEY);
    const added = await call("POST", "/api/admin/profiles", admin, { name: "Mina", code: "246810", preset: "cat-rose" });
    expect(added.status).toBe(201);
    const minaId = ((await added.json()) as PublicProfile).id;
    return { admin, adminId, mina: await signIn(minaId, "246810"), minaId };
  }

  async function upload(call: Call, cookie: string, parsed: ParsedBook): Promise<string> {
    const form = new FormData();
    form.set("file", new File([pdfBytes(parsed)], "book.pdf", { type: "application/pdf" }));
    const response = await call("POST", "/api/books", cookie, form);
    expect(response.status).toBe(201);
    return ((await response.json()) as BookSummary).id;
  }

  it("should translate a chapter for anyone without profiles, and refuse a bad language, book or chapter", async () => {
    const app = createApp({ ...fakes, library: createLibrary(dataDir), translation: translation() });
    const form = new FormData();
    form.set("file", new File([pdfBytes(book("Problems", TEXTS))], "book.pdf", { type: "application/pdf" }));
    const id = ((await (await app.request("/api/books", { method: "POST", body: form })).json()) as BookSummary).id;

    const response = await app.request(`/api/books/${id}/chapters/c1/translation?lang=bn`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ChapterTranslation).blocks["c1-b2"]).toBe("ms:The table looks brown.");
    expect(await (await app.request("/api/translation")).json()).toEqual({ enabled: true, engine: "auto" });

    const refused: Array<[string, number, string]> = [
      [`/api/books/${id}/chapters/c1/translation?lang=xx`, 400, "invalid_lang"],
      [`/api/books/${id}/chapters/c1/translation`, 400, "invalid_lang"],
      [`/api/books/missing-book-12345678/chapters/c1/translation?lang=bn`, 404, "book_not_found"],
      [`/api/books/${id}/chapters/c9/translation?lang=bn`, 404, "chapter_not_found"],
      // With one library there is no admin, so nothing of the admin's is there.
      ["/api/admin/translation", 404, "not_found"],
    ];
    for (const [path, status, error] of refused) {
      const answer = await app.request(path);
      expect(answer.status, path).toBe(status);
      expect(((await answer.json()) as ApiError).error).toBe(error);
    }

    answers.microsoft = () => new Response("busy", { status: 503 });
    answers.google = robotCheck;
    const failed = await app.request(`/api/books/${id}/chapters/c1/translation?lang=fr`);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "translation_unavailable", message: "The translation services could not be reached just now." });
  });

  it("should let only the admin choose, and keep readers out of translation while it is off", async () => {
    let call = await start();
    const { admin, mina } = await signedIn(call);
    const minas = await upload(call, mina, book("Problems", TEXTS));
    const admins = await upload(call, admin, book("Analysis of Mind", TEXTS));

    expect(await (await call("GET", "/api/admin/translation", admin)).json()).toEqual({ enabled: true, engine: "auto" });
    for (const [method, path, body] of [
      ["GET", "/api/admin/translation", undefined],
      ["PUT", "/api/admin/translation", { enabled: false }],
      ["POST", "/api/admin/translation/test", { lang: "bn" }],
    ] as const) {
      const response = await call(method, path, mina, body);
      expect(response.status).toBe(403);
      expect(((await response.json()) as ApiError).error).toBe("admin_only");
    }
    for (const body of [{ engine: "deepl" }, { enabled: "no" }, { enabled: null }, {}, "not json"]) {
      const response = await call("PUT", "/api/admin/translation", admin, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).message).toMatch(/\.$/);
    }
    expect(await (await call("PUT", "/api/admin/translation", admin, { enabled: false, engine: "google" })).json()).toEqual({ enabled: false, engine: "google" });

    // The choice outlives a restart.
    call = await start();
    const off = await call("GET", `/api/books/${minas}/chapters/c1/translation?lang=bn`, mina);
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ error: "translation_off", message: "The admin has turned translation off." });
    expect(await (await call("GET", "/api/translation", mina)).json()).toEqual({ enabled: false, engine: "google" });
    expect(net.calls).toHaveLength(0);

    // The admin always may, with the service they chose.
    expect(await (await call("GET", "/api/translation", admin)).json()).toEqual({ enabled: true, engine: "google" });
    const theirs = await call("GET", `/api/books/${admins}/chapters/c1/translation?lang=bn`, admin);
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as ChapterTranslation).engine).toBe("google");
    expect(new Set(net.calls.map((made) => made.service))).toEqual(new Set(["google"]));
  });

  it("should keep a shared book's translation with its owner, and try the chosen service for the admin", async () => {
    const call = await start();
    const { admin, adminId, mina, minaId } = await signedIn(call);
    const id = await upload(call, admin, book("Problems", TEXTS));
    expect((await call("PUT", `/api/books/${id}/shares/${minaId}`, admin)).status).toBe(204);

    const read = await call("GET", `/api/books/${adminId}--${id}/chapters/c1/translation?lang=bn`, mina);
    expect(read.status).toBe(200);
    expect(net.calls).toHaveLength(1);
    // The owner opens the same chapter: it was translated once, for everyone who reads the book.
    const owned = await call("GET", `/api/books/${id}/chapters/c1/translation?lang=bn`, admin);
    expect(await owned.json()).toEqual(await read.json());
    expect(net.calls).toHaveLength(1);

    const tried = (await (await call("POST", "/api/admin/translation/test", admin, { lang: "bn" })).json()) as TranslationTest;
    expect(tried).toMatchObject({ ok: true, engine: "microsoft", sample: TRANSLATION_SAMPLE, translation: `ms:${TRANSLATION_SAMPLE}` });
    expect((await call("POST", "/api/admin/translation/test", admin, { lang: "xx" })).status).toBe(400);
    answers.microsoft = () => new Response("busy", { status: 503 });
    answers.google = robotCheck;
    const failed = (await (await call("POST", "/api/admin/translation/test", admin, { lang: "bn" })).json()) as TranslationTest;
    expect(failed).toEqual({ ok: false, message: expect.stringMatching(/^Neither Microsoft nor Google could translate .*Microsoft answered 503.*\.$/) });
  });
});

describe("createTranslationSettings", () => {
  it("should start from translation on with auto, and keep what the admin saves across a restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "deepread-translation-settings-"));
    try {
      expect(createTranslationSettings(dataDir).get()).toEqual({ enabled: true, engine: "auto" } satisfies TranslationSettings);
      await createTranslationSettings(dataDir).save({ engine: "microsoft" });
      await createTranslationSettings(dataDir).save({ enabled: false });
      expect(createTranslationSettings(dataDir).get()).toEqual({ enabled: false, engine: "microsoft" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
