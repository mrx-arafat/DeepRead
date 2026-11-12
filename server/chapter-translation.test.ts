// Chapter translation with an injected fetch, so nothing touches the network: the services' answers are shaped like the
// ones Microsoft's and Google's endpoints gave. The routes run through createApp on real disk storage in a temp dir.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, BookSummary, Chapter, ChapterTranslation, ParsedBook, PublicProfile, TranslationSettings, TranslationTest } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import { createApp } from "./app.ts";
import { createChapterTranslator, createTranslationSettings, TRANSLATION_SAMPLE, TranslationError, translateTexts } from "./chapter-translation.ts";
import type { AiHelp } from "./chapter-translation.ts";
import type { ParsePdf } from "./deps.ts";
import { createLibrary } from "./library.ts";
import type { Library } from "./library.ts";
import { LlmError } from "./llm.ts";
import { parseStyleReply } from "./translation-style.ts";
import type { BookStyle, StyleKeeper } from "./translation-style.ts";
import type { Llm } from "./llm.ts";
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

  it("should send a long chapter's Microsoft requests side by side, at most three at once, and keep their order", async () => {
    let open = 0;
    let most = 0;
    const { fetchImpl, calls } = services({
      microsoft: async (texts) => {
        open += 1;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 20));
        open -= 1;
        return Response.json(texts.map((text) => ({ translations: [{ text: `ms:${text}` }] })));
      },
    });
    const long = Array.from({ length: 9 }, (_, at) => `${at}`.repeat(15_000));
    expect((await translateTexts(long, "bn", "auto", { fetchImpl })).map((made) => made.text)).toEqual(long.map((text) => `ms:${text}`));
    expect(calls.map((call) => call.texts.length)).toEqual([2, 2, 2, 2, 1]);
    expect(most).toBe(3);
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

describe("a blank translation from a service", () => {
  it("should be a failure to fall back from, never a translation to keep", async () => {
    const blank = services({ microsoft: (texts) => Response.json(texts.map((text, at) => ({ translations: [{ text: at === 1 ? "  " : `ms:${text}` }] }))) });
    // Under Automatic Google stands in for the whole batch; Microsoft alone fails.
    const made = await translateTexts(["One paragraph.", "Another paragraph."], "bn", "auto", { fetchImpl: blank.fetchImpl });
    expect(made.map((one) => one.engine)).toEqual(["google", "google"]);
    await expect(translateTexts(["One paragraph.", "Another paragraph."], "bn", "microsoft", { fetchImpl: blank.fetchImpl })).rejects.toThrow("blank translation");
    const emptied = services({ google: () => Response.json([[["", "x"]], null, "en"]) });
    await expect(translateTexts(["Only paragraph."], "bn", "google", { fetchImpl: emptied.fetchImpl })).rejects.toBeInstanceOf(TranslationError);
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

  it("translates recovered words and preserved code without sending figure assets", async () => {
    const { fetchImpl, calls } = services();
    const illustrated: Chapter = { ...chapter([]), blocks: [
      { id: "figure", type: "image", text: "", page: 1, image: { src: `figures/${"a".repeat(64)}.png`, width: 80, height: 60, alt: "Illustration" } },
      { id: "ocr", type: "paragraph", text: "Recovered words.", page: 1 },
      { id: "code", type: "code", text: "  return value;\nnext();", page: 1 },
    ] };
    const translated = await createChapterTranslator({ fetchImpl }).chapter({ library, bookId }, illustrated, "bn", "auto");
    expect(calls.map(({ texts }) => texts)).toEqual([["Recovered words.", "  return value;\nnext();"]]);
    expect(translated.blocks.figure).toBeUndefined();
    expect(translated.blocks.ocr).toBe("ms:Recovered words.");
    expect(translated.blocks.code).toContain("return value;");
  });

  it("should make a block again whose kept translation is blank, never count it as translated", async () => {
    const { fetchImpl, calls } = services();
    const source = createHash("sha256").update("Appearance and reality.").digest("hex").slice(0, 16);
    await library.writeTranslation(bookId, "bn", "c1", { blocks: { "c1-b1": { text: " ", engine: "microsoft", source } } });
    const made = await createChapterTranslator({ fetchImpl }).chapter({ library, bookId }, chapter(TEXTS), "bn", "auto");
    expect(made.blocks["c1-b1"]).toBe("ms:Appearance and reality.");
    expect(calls[0]?.texts).toContain("Appearance and reality.");
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

  it("should keep a chapter's whole translation in memory once read back, and not past its book's removal", async () => {
    const { fetchImpl, calls } = services();
    const translator = createChapterTranslator({ fetchImpl });
    const reads = vi.spyOn(library, "readTranslation");
    // The parsed chapter, as the route passes it.
    const parsed = (await library.book(bookId))!.chapters[0]!;
    const first = await translator.chapter({ library, bookId }, parsed, "bn", "auto");
    // Read back whole from the book once, then answered from memory.
    expect(await translator.chapter({ library, bookId }, parsed, "bn", "auto")).toEqual(first);
    expect(await translator.chapter({ library, bookId }, parsed, "bn", "auto")).toEqual(first);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);

    // Removed and added again: its translation went with it, so the chapter is translated again.
    await library.remove(bookId);
    const uploadPath = await library.newUploadPath("book");
    await writeFile(uploadPath, "%PDF-1.4");
    await library.add({ uploadPath, sha256: "ab".repeat(32), parsed: book("Problems", TEXTS), cover: null });
    expect(await translator.chapter({ library, bookId }, (await library.book(bookId))!.chapters[0]!, "bn", "auto")).toEqual(first);
    expect(calls).toHaveLength(2);
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

  describe("with an AI helper", () => {
    const BOOK = { title: "Problems", author: "Russell" };
    /** Bangla-looking text as long as the English, so it passes the checks a real translation does. */
    const bangla = (id: string, text: string): string => `অনুবাদ ${id} ${"ক".repeat(Math.max(0, text.length - 13))}।`;
    /** Four paragraphs of about a thousand characters under a heading: a small first batch, then one for the rest. */
    const LONG = ["A Heading", ...Array.from({ length: 4 }, (_, at) => `Paragraph ${at}. ${"word ".repeat(200)}`)];

    // A fallback and a refused paragraph are logged for the admin; these tests expect that.
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** An AI helper whose answer is made by `reply` from the paragraphs asked about; every question it was asked is kept. */
    function helper(reply: (asked: Array<{ id: string; text: string }>, nth: number) => string | Promise<string>) {
      const questions: Array<{ system: string; user: string; asked: Array<{ id: string; text: string }> }> = [];
      const llm: Llm = {
        model: () => "fake",
        streamText: (request) =>
          (async function* () {
            const listed = request.user.split("The paragraphs:\n")[1] ?? "";
            const asked = [...listed.matchAll(/^=== (\S+) ===\n([\s\S]*?)(?=\n\n=== |$)/gm)].map((one) => ({ id: one[1] ?? "", text: one[2] ?? "" }));
            questions.push({ system: request.system, user: request.user, asked });
            yield await reply(asked, questions.length);
          })(),
      };
      const help: AiHelp = { llm, who: "mina", book: BOOK };
      return { help, questions };
    }
    const END = "=== end ===";
    const faithful = (asked: Array<{ id: string; text: string }>): string => [...asked.map(({ id, text }) => `=== ${id} ===\n${bangla(id, text)}`), END].join("\n\n");

    it("should translate in batches with the paragraphs before as context, answer in parts, and keep the result as the AI's", async () => {
      const { fetchImpl, calls } = services();
      let release = (): void => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const { help, questions } = helper(async (asked, nth) => {
        if (nth === 2) await held;
        return faithful(asked);
      });
      const translator = createChapterTranslator({ fetchImpl });
      const parsed = chapter(LONG);

      // The first batch (the heading and the first paragraph) arrives while the second is still being made.
      const part = await translator.chapter({ library, bookId }, parsed, "bn", "auto", help);
      expect(part.complete).toBe(false);
      expect(Object.keys(part.blocks)).toEqual(["c1-b0", "c1-b1"]);
      expect(part.engine).toBe("ai");
      release();
      await vi.waitFor(async () => expect((await translator.chapter({ library, bookId }, parsed, "bn", "auto", help)).complete).toBeUndefined());

      const whole = await translator.chapter({ library, bookId }, parsed, "bn", "auto", help);
      expect(Object.keys(whole.blocks)).toEqual(parsed.blocks.map((block) => block.id));
      expect(whole.blocks["c1-b4"]).toBe(bangla("c1-b4", parsed.blocks[4]?.text ?? ""));
      // Nothing went to the free services, and the second question carried the book, and the first batch with its Bangla.
      expect(calls).toHaveLength(0);
      expect(questions).toHaveLength(2);
      expect(questions[1]?.asked.map((one) => one.id)).toEqual(["c1-b2", "c1-b3", "c1-b4"]);
      expect(questions[1]?.user).toContain('Book: "Problems" by Russell.');
      expect(questions[1]?.user).toContain(`[English] ${parsed.blocks[1]?.text}\n[Bangla] ${bangla("c1-b1", parsed.blocks[1]?.text ?? "")}`);
      // Kept with the book as the AI's, and reused with no more questions.
      const kept = (await library.readTranslation(bookId, "bn", "c1")) as { blocks: Record<string, { engine: string }> };
      expect(new Set(Object.values(kept.blocks).map((one) => one.engine))).toEqual(new Set(["ai"]));
      await translator.chapter({ library, bookId }, parsed, "bn", "auto", help);
      expect(questions).toHaveLength(2);
    });

    it("should make again with the AI what a service made, but only for a reader who has a helper", async () => {
      const { fetchImpl, calls } = services();
      const { help, questions } = helper(faithful);
      const translator = createChapterTranslator({ fetchImpl });
      const parsed = chapter(TEXTS);
      const first = await translator.chapter({ library, bookId }, parsed, "bn", "auto");
      expect(first.blocks["c1-b1"]).toBe("ms:Appearance and reality.");
      // A reader without a helper keeps what is there; one with a helper has the chapter made better.
      expect((await translator.chapter({ library, bookId }, parsed, "bn", "auto")).blocks["c1-b1"]).toBe("ms:Appearance and reality.");
      const better = await translator.chapter({ library, bookId }, parsed, "bn", "auto", help);
      expect(better.blocks["c1-b1"]).toBe(bangla("c1-b1", "Appearance and reality."));
      expect(better.engine).toBe("ai");
      // One batch, so the first answer is already the whole chapter and says so.
      expect(better.complete).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(questions).toHaveLength(1);
    });

    it("should ask again for a paragraph the AI got wrong, then let a service make it and not ask the AI for it again", async () => {
      const { fetchImpl, calls } = services();
      const { help, questions } = helper((asked) =>
        [...asked.map(({ id, text }) => `=== ${id} ===\n${id === "c1-b2" ? text : bangla(id, text)}`), END].join("\n\n"),
      );
      const translator = createChapterTranslator({ fetchImpl });
      const parsed = chapter(TEXTS);
      const made = await translator.chapter({ library, bookId }, parsed, "bn", "auto", help);
      // The whole batch, then only the paragraph that was still English; that one is Microsoft's.
      expect(questions.map((one) => one.asked.map((ask) => ask.id))).toEqual([["c1-b0", "c1-b1", "c1-b2", "c1-b4"], ["c1-b2"]]);
      expect(questions[1]?.user).toContain("c1-b2: it was still mostly English");
      expect(made.blocks["c1-b2"]).toBe("ms:The table looks brown.");
      expect(made.blocks["c1-b1"]).toBe(bangla("c1-b1", "Appearance and reality."));
      expect(calls.map((call) => call.texts)).toEqual([["The table looks brown."]]);
      // Opening it again asks nobody: the AI already failed at that very text.
      await translator.chapter({ library, bookId }, parsed, "bn", "auto", help);
      expect(questions).toHaveLength(2);
    });

    it("should hand a chapter to the services when the helper fails, leave the helper alone for a while, and refuse to fall back when only the AI was chosen", async () => {
      const { fetchImpl, calls } = services();
      let now = 0;
      const { help, questions } = helper(() => {
        throw new LlmError("not_logged_in", "Claude Code is not signed in on this computer.");
      });
      const translator = createChapterTranslator({ fetchImpl, now: () => now });
      const made = await translator.chapter({ library, bookId }, chapter(TEXTS), "bn", "auto", help);
      expect(made).toMatchObject({ engine: "microsoft", blocks: { "c1-b1": "ms:Appearance and reality." } });
      // Another chapter soon after goes straight to the services, without waiting on a helper that just failed.
      await translator.chapter({ library, bookId }, { ...chapter(["Next", "Another paragraph."]), id: "c2" }, "bn", "auto", help);
      expect(questions).toHaveLength(1);
      expect(calls).toHaveLength(2);
      // Later the helper is tried again.
      now += 4 * 60_000;
      await translator.chapter({ library, bookId }, { ...chapter(["Last", "One more paragraph."]), id: "c3" }, "bn", "auto", help);
      expect(questions).toHaveLength(2);

      // Chosen alone, the AI never falls back: the reader is told why, and no service is asked.
      const before = calls.length;
      await expect(translator.chapter({ library, bookId }, chapter(TEXTS), "id", "ai", help)).rejects.toMatchObject({ readerMessage: "Claude Code is not signed in on this computer." });
      await expect(translator.chapter({ library, bookId }, chapter(TEXTS), "tr", "ai")).rejects.toMatchObject({ readerMessage: expect.stringContaining("needs one") });
      expect(calls).toHaveLength(before);
    });

    it("should keep the paragraphs the AI got right when its second question fails, and let a service make only the one left", async () => {
      const { fetchImpl, calls } = services();
      let nth = 0;
      const { help, questions } = helper((asked) => {
        nth += 1;
        if (nth === 2) throw new LlmError("timeout", "The AI took too long to answer. Please try again.");
        return [...asked.filter(({ id }) => id !== "c1-b2").map(({ id, text }) => `=== ${id} ===\n${bangla(id, text)}`), END].join("\n\n");
      });
      const translator = createChapterTranslator({ fetchImpl });
      const made = await translator.chapter({ library, bookId }, chapter(TEXTS), "bn", "auto", help);
      expect(questions).toHaveLength(2);
      expect(made.blocks["c1-b1"]).toBe(bangla("c1-b1", "Appearance and reality."));
      expect(made.blocks["c1-b4"]).toBe(bangla("c1-b4", "We will call it a physical object."));
      expect(made.blocks["c1-b2"]).toBe("ms:The table looks brown.");
      expect(calls.map((call) => call.texts)).toEqual([["The table looks brown."]]);
      // A timeout is not the helper's failure at that text, so it is not marked as one and a later visit may try again.
      const kept = (await library.readTranslation(bookId, "bn", "c1")) as { blocks: Record<string, { engine: string; aiTried?: boolean }> };
      expect(kept.blocks["c1-b1"]?.engine).toBe("ai");
      expect(kept.blocks["c1-b2"]).toMatchObject({ engine: "microsoft" });
      expect(kept.blocks["c1-b2"]?.aiTried).toBeUndefined();
    });

    it("should keep the prose it made and then fail the chapter, never call it whole, when the services cannot translate a table", async () => {
      const { fetchImpl } = services({ microsoft: () => new Response("busy", { status: 503 }), google: robotCheck });
      const { help } = helper(faithful);
      const translator = createChapterTranslator({ fetchImpl });
      const withTable: Chapter = { ...chapter(["A Heading", "A paragraph that has words in it."]), blocks: [...chapter(["A Heading", "A paragraph that has words in it."]).blocks, { id: "c1-table", type: "table", text: "one\ttwo\nthree\tfour", page: 1 }] };
      const part = await translator.chapter({ library, bookId }, withTable, "bn", "auto", help);
      expect(part.complete).toBe(false);
      expect(part.blocks["c1-b1"]).toBe(bangla("c1-b1", "A paragraph that has words in it."));
      expect(part.blocks["c1-table"]).toBeUndefined();
      await vi.waitFor(async () => {
        await expect(translator.chapter({ library, bookId }, withTable, "bn", "auto", help)).rejects.toBeInstanceOf(TranslationError);
      });
    });

    it("should make the chapter again with the second reader's own helper when the first reader's helper failed the run they both joined", async () => {
      const { fetchImpl } = services();
      let release = (): void => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const alice = helper(async () => {
        await held;
        throw new LlmError("failed", "You have used today's 100 requests of the admin's API model.");
      });
      const bob = helper(faithful);
      const translator = createChapterTranslator({ fetchImpl });
      const parsed = chapter(TEXTS);
      const first = translator.chapter({ library, bookId }, parsed, "bn", "ai", { ...alice.help, who: "alice" });
      const second = translator.chapter({ library, bookId }, parsed, "bn", "ai", { ...bob.help, who: "bob" });
      const failure = expect(first).rejects.toMatchObject({ readerMessage: expect.stringContaining("today's 100 requests") });
      release();
      await failure;
      expect((await second).blocks["c1-b1"]).toBe(bangla("c1-b1", "Appearance and reality."));
      expect(bob.questions).toHaveLength(1);
    });

    it("should give each batch the notes of its own people, found from the batch and the paragraphs before it", async () => {
      const { fetchImpl } = services();
      const { help, questions } = helper(faithful);
      const passages: string[] = [];
      const translator = createChapterTranslator({ fetchImpl });
      const parsed = chapter(LONG);
      await translator.chapter({ library, bookId }, parsed, "bn", "auto", { ...help, notes: async (passage) => (passages.push(passage), `NOTE ${passages.length}`) });
      await vi.waitFor(async () => expect((await translator.chapter({ library, bookId }, parsed, "bn", "auto", help)).complete).toBeUndefined());
      expect(passages).toHaveLength(2);
      // The first batch has nothing before it; the second is read with the paragraphs before it.
      expect(passages[0]).toBe(parsed.blocks.slice(0, 2).map((block) => block.text).join("\n\n"));
      expect(passages[1]).toBe(parsed.blocks.map((block) => block.text).join("\n\n"));
      expect(questions[0]?.user).toContain("Notes about this book:\nNOTE 1");
      expect(questions[1]?.user).toContain("Notes about this book:\nNOTE 2");
    });
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
  async function start(llm: Ai = fakeLlm): Promise<Call> {
    const profiles = createProfiles({ store: createLocalStore(dataDir), dataDir, limit: null, adminPasskey: PASSKEY, adminName: "Arafat" });
    started.push(profiles);
    const app = createApp({ ...fakes, llm, accounts: { profiles, sessionKey: sessionKey(await loadSessionSecret(dataDir), PASSKEY) }, translation: translation() });
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

  it("should gzip a long translation under its tag marked weak, answer 304 to it, and tag a changed translation anew", async () => {
    const app = createApp({ ...fakes, library: createLibrary(dataDir), translation: translation() });
    const form = new FormData();
    form.set("file", new File([pdfBytes(book("Problems", [...TEXTS, "A sentence long enough to be worth compressing. ".repeat(40)]))], "book.pdf", { type: "application/pdf" }));
    const id = ((await (await app.request("/api/books", { method: "POST", body: form })).json()) as BookSummary).id;
    const url = `/api/books/${id}/chapters/c1/translation?lang=bn`;
    const plain = await app.request(url);
    const tag = plain.headers.get("etag") ?? "";
    expect(tag).toMatch(/^"[^"]+"$/);
    expect(plain.headers.get("cache-control")).toBe("private, no-cache");
    const zipped = await app.request(url, { headers: { "accept-encoding": "gzip" } });
    expect([zipped.headers.get("content-encoding"), zipped.headers.get("etag")]).toEqual(["gzip", `W/${tag}`]);
    const text = await plain.text();
    expect(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString("utf8")).toBe(text);
    expect((await app.request(url, { headers: { "accept-encoding": "gzip", "if-none-match": `W/${tag}` } })).status).toBe(304);
    // Changed where it is kept while DeepRead was stopped: the next answer is the new translation, under a new tag.
    const keptFile = join(dataDir, "books", id, "translations", "bn", "c1.json");
    await writeFile(keptFile, (await readFile(keptFile, "utf8")).replace("ms:The table looks brown.", "ms:The table looks red."));
    const restarted = createApp({ ...fakes, library: createLibrary(dataDir), translation: translation() });
    const changed = await restarted.request(url, { headers: { "accept-encoding": "gzip", "if-none-match": `W/${tag}` } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(`W/${tag}`);
    expect(JSON.parse(gunzipSync(Buffer.from(await changed.arrayBuffer())).toString("utf8")).blocks["c1-b2"]).toBe("ms:The table looks red.");
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

  it("should translate with the AI helper for the reader who has one, tell the one who has none why not, and let the admin try it", async () => {
    const llm: Llm = {
      model: () => "fake",
      streamText: (request) =>
        (async function* () {
          const asked = [...(request.user.split("The paragraphs:\n")[1] ?? "").matchAll(/^=== (\S+) ===\n([\s\S]*?)(?=\n\n=== |$)/gm)];
          yield [...asked.map(([, id, text]) => `=== ${id} ===\nবাংলা ${id} ${"ক".repeat(Math.max(0, (text ?? "").length))}।`), "=== end ==="].join("\n\n");
        })(),
    };
    // Only the admin (who may use anything that works) has a helper; Mina has none.
    const call = await start({ ...fakeLlm, statusFor: async (access) => ({ active: access.allowed === "all" ? "claude" : null, providers: [] }), for: () => llm });
    const { admin, adminId, mina, minaId } = await signedIn(call);
    const id = await upload(call, admin, book("Problems", TEXTS));
    expect((await call("PUT", `/api/books/${id}/shares/${minaId}`, admin)).status).toBe(204);
    const shared = `${adminId}--${id}`;
    expect((await call("PUT", "/api/admin/translation", admin, { engine: "ai" })).status).toBe(200);

    const made = (await (await call("GET", `/api/books/${id}/chapters/c1/translation?lang=bn`, admin)).json()) as ChapterTranslation;
    expect(made.engine).toBe("ai");
    expect(made.blocks["c1-b1"]).toContain("বাংলা c1-b1");
    expect(net.calls).toHaveLength(0);

    // Mina has none, and nothing is kept for this chapter in Hindi: she is told what is missing.
    const refused = await call("GET", `/api/books/${shared}/chapters/c1/translation?lang=hi`, mina);
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as ApiError).message).toContain("needs one");
    // What the admin's helper made is hers to read, too.
    expect(((await (await call("GET", `/api/books/${shared}/chapters/c1/translation?lang=bn`, mina)).json()) as ChapterTranslation).engine).toBe("ai");

    const tried = (await (await call("POST", "/api/admin/translation/test", admin, { lang: "bn" })).json()) as TranslationTest;
    expect(tried).toMatchObject({ ok: true, engine: "ai", sample: TRANSLATION_SAMPLE });
  });

  it("should translate a chapter with the book's translator's notes, making them first when the book has none, and add the names a chapter brings", async () => {
    const sheet = parseStyleReply(
      JSON.stringify({
        narrator: "Marlow tells it in the first person, plain and reflective, in natural চলিত.",
        characters: [{ name: "Marlow", rendering: "মার্লো", role: "the narrator" }, { name: "Kurtz", rendering: "কুর্টজ", role: "an ivory agent" }],
        address: [{ from: "Marlow", to: "Kurtz", level: "familiar", why: "friends" }],
        glossary: [],
      }),
      "bn",
    ) as BookStyle;
    // The notes do not exist until the first request makes them, as for a book never translated.
    let made: BookStyle | null = null;
    const asked: Array<{ chapter?: Chapter }> = [];
    const styles: StyleKeeper = {
      style: async () => made,
      ensure: async (request) => {
        asked.push({ chapter: request.chapter });
        made ??= sheet;
        return made;
      },
    };
    const prompts: string[] = [];
    const llm: Ai = {
      ...fakeLlm,
      statusFor: async () => ({ active: "claude", providers: [] }),
      streamText: (request) =>
        (async function* () {
          prompts.push(request.user);
          const listed = request.user.split("The paragraphs:\n")[1] ?? "";
          yield [...[...listed.matchAll(/^=== (\S+) ===\n([\s\S]*?)(?=\n\n=== |$)/gm)].map(([, id, text]) => `=== ${id} ===\nবাংলা ${id} ${"ক".repeat((text ?? "").length)}।`), "=== end ==="].join("\n\n");
        })(),
    };
    const app = createApp({ ...fakes, llm, library: createLibrary(dataDir), translation: { ...translation(), styles } });
    const form = new FormData();
    form.set("file", new File([pdfBytes(book("Heart", ["Part One", "Marlow spoke to Kurtz at the station."]))], "book.pdf", { type: "application/pdf" }));
    const id = ((await (await app.request("/api/books", { method: "POST", body: form })).json()) as BookSummary).id;

    const response = await app.request(`/api/books/${id}/chapters/c1/translation?lang=bn`);
    expect(((await response.json()) as ChapterTranslation).engine).toBe("ai");
    expect(prompts[0]).toContain("Notes about this book:");
    expect(prompts[0]).toContain("মার্লো");
    // The chapter went to the keeper, which grows the notes with the names it brings.
    expect(asked[0]?.chapter?.id).toBe("c1");
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
