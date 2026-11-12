// Functional test of the natural voice over HTTP: real routes and real disk storage in a temp dir, with the PDF parser
// and the voice box replaced by fakes (no network, no model).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, ParsedBook } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import type { AppEnv } from "./app-env.ts";
import { createApp } from "./app.ts";
import type { ParsePdf } from "./deps.ts";
import { createLibrary } from "./library.ts";
import type { Library } from "./library.ts";
import { VoiceUnavailable } from "./voice.ts";
import type { Voice } from "./voice.ts";

const book: ParsedBook = {
  title: "Heart of Darkness",
  author: "Joseph Conrad",
  pageCount: 2,
  warnings: [],
  chapters: [{ id: "c1", title: "I", startPage: 1, endPage: 2, blocks: [{ id: "c1-b1", type: "paragraph", text: "The Nellie, a cruising yawl, swung to her anchor.", page: 1 }] }],
};

const fakeParsePdf: ParsePdf = async (path) => JSON.parse((await readFile(path, "utf8")).split("\n")[1] ?? "") as ParsedBook;
const noLlm = {} as Ai;
const mp3Of = (text: string, speed: number) => Buffer.from(`ID3 ${speed} ${text}`);

describe("the natural voice from the server", () => {
  let dataDir: string;
  let library: Library;
  let asked: Array<{ text: string; speed: number }>;
  let down: boolean;
  const voice: Voice = {
    async clip(text, speed) {
      asked.push({ text, speed });
      if (down) throw new VoiceUnavailable("the voice box did not answer");
      return mp3Of(text, speed);
    },
  };
  let app: Hono<AppEnv>;
  const appWith = (box: Voice | undefined) => createApp({ library, parsePdf: fakeParsePdf, renderCover: async () => null, llm: noLlm, quickTranslate: async (text) => text, voice: box });

  const addBook = async (): Promise<string> => {
    const form = new FormData();
    form.set("file", new File([`%PDF-1.4\n${JSON.stringify(book)}`], "book.pdf", { type: "application/pdf" }));
    return ((await (await app.request("/api/books", { method: "POST", body: form })).json()) as { id: string }).id;
  };
  const speak = (id: string, body: unknown, on: Hono<AppEnv> = app) =>
    on.request(`/api/books/${id}/voice`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-voice-test-"));
    library = createLibrary(dataDir);
    asked = [];
    down = false;
    app = appWith(voice);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("should say whether this server reads the natural voice", async () => {
    expect(await (await app.request("/api/voice")).json()).toEqual({ server: true });
    expect(await (await appWith(undefined).request("/api/voice")).json()).toEqual({ server: false });
  });

  it("should read a sentence of the reader's book as an MP3, and make each sentence only once for everyone", async () => {
    const id = await addBook();
    const sentence = { text: "The Nellie, a cruising yawl, swung to her anchor.", speed: 1 };

    const first = await speak(id, sentence);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(mp3Of(sentence.text, 1));

    // Kept with the book: asked again, also after DeepRead starts again, the voice box is not.
    library = createLibrary(dataDir);
    const again = await speak(id, sentence, appWith(voice));
    expect(Buffer.from(await again.arrayBuffer())).toEqual(mp3Of(sentence.text, 1));
    expect(asked).toEqual([sentence]);

    // Another speed is another clip.
    await speak(id, { ...sentence, speed: 1.5 });
    expect(asked).toEqual([sentence, { ...sentence, speed: 1.5 }]);
  });

  it("should let go of a book's clips when the book is removed", async () => {
    const id = await addBook();
    await speak(id, { text: "The Nellie swung to her anchor.", speed: 1 });
    await app.request(`/api/books/${id}`, { method: "DELETE" });
    expect((await speak(id, { text: "The Nellie swung to her anchor.", speed: 1 })).status).toBe(404);
    expect((await library.usage()).used).toBe(0);
  });

  it("should say the voice is unavailable, keeping nothing, when the voice box cannot answer", async () => {
    const id = await addBook();
    down = true;
    const failed = await speak(id, { text: "The sea-reach of the Thames.", speed: 1 });
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as ApiError).error).toBe("voice_unavailable");

    down = false;
    expect((await speak(id, { text: "The sea-reach of the Thames.", speed: 1 })).status).toBe(200);
    expect(asked).toHaveLength(2);
  });

  it("should refuse what is not a sentence of a book the reader has", async () => {
    const id = await addBook();
    expect((await speak("no-such-book-00000000", { text: "Hello.", speed: 1 })).status).toBe(404);
    expect((await speak(id, { text: "   ", speed: 1 })).status).toBe(400);
    expect((await speak(id, { text: "x".repeat(1201), speed: 1 })).status).toBe(400);
    expect((await speak(id, { text: "Hello.", speed: 3 })).status).toBe(400);
    expect((await speak(id, { text: "Hello." })).status).toBe(400);
    expect(asked).toEqual([]);
  });

  it("should not know the address on a server without a voice box", async () => {
    const id = await addBook();
    expect((await speak(id, { text: "Hello.", speed: 1 }, appWith(undefined))).status).toBe(404);
  });
});
