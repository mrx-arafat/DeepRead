// A whole chapter in the reader's language, paragraph by paragraph, from a keyless public translation service rather than
// an AI helper, so it is quick and costs nothing. Microsoft's Edge endpoint answers first; Google's gtx endpoint stands in
// when it cannot, and the admin may choose either alone. Both are unofficial, so any request can fail: each has a timeout,
// and a failure is a TranslationError with a short reason for the server log, never a translation.
// Each chapter is translated once. The translation is kept with the book (library.ts), beside a fingerprint of each block's
// text, so every reader and device reuses it, and a book parsed again has only the blocks that changed translated again.
// The admin's choice, whether readers may and which service translates, is kept in <dataDir>/translation.json.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TRANSLATION_ENGINES } from "../shared/types.ts";
import type { Chapter, ChapterTranslation, LangCode, TranslationEngine, TranslationSettings, TranslationTest } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { isRecord } from "./http.ts";
import type { Library } from "./library.ts";

const MICROSOFT = "https://edge.microsoft.com/translate/translatetext";
const GOOGLE = "https://translate.googleapis.com/translate_a/single";
// Measured: 60 paragraphs (18,000 characters) came back in 0.6 s, so a chapter is usually one request.
const MICROSOFT_MAX_TEXTS = 100;
const MICROSOFT_MAX_CHARS = 40_000;
// Google takes the text in the address, which it refuses past a length: a longer paragraph goes in pieces.
const GOOGLE_MAX_CHARS = 4_500;
// Google takes one paragraph a request and is quick to suspect a robot, so only a few go at once.
const GOOGLE_AT_ONCE = 4;
const TIMEOUT_MS = 15_000;
const FINGERPRINT_CHARS = 16;
const SETTINGS_FILE = "translation.json";

/** What the admin's test translates: a plain sentence with a clause in the middle, as books have. */
export const TRANSLATION_SAMPLE = "The real table, if it exists, we will call a physical object.";

const DEFAULT_SETTINGS: TranslationSettings = { enabled: true, engine: "auto" };

/** A service that makes translations. */
type Service = ChapterTranslation["engine"];

const NAMES: Record<Service, string> = { microsoft: "Microsoft", google: "Google" };

/** A service could not translate. The message is a short reason for the server log, like "Google answered 302". */
export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

export type EngineOptions = {
  /** Replaceable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** How long one request may take. */
  timeoutMs?: number;
};

/** One translation, and the service that made it. */
export type Translated = { text: string; engine: Service };

export const isTranslationEngine = (value: unknown): value is TranslationEngine =>
  typeof value === "string" && (TRANSLATION_ENGINES as readonly string[]).includes(value);

/** What `service` answers, as JSON. Every way it can fail is a TranslationError: unreachable, slow, refusing, or a page. */
async function ask(service: Service, url: string, init: RequestInit, options: EngineOptions): Promise<unknown> {
  const name = NAMES[service];
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let response: Response;
  let body: string;
  try {
    // A redirect is never followed: Google's leads to its robot check, which is a page and not a translation.
    response = await (options.fetchImpl ?? fetch)(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    body = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new TranslationError(`${name} did not answer within ${timeoutMs} ms`);
    throw new TranslationError(`${name} could not be reached (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) {
    const location = response.headers.get("location");
    const to = location ? URL.parse(location, url) : null;
    throw new TranslationError(`${name} answered ${response.status}${to ? ` (to ${to.host}${to.pathname})` : ""}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new TranslationError(`${name} answered with a page, not a translation`);
  }
}

/** The texts in the groups Microsoft takes in one request, in order. One text longer than a group goes alone. */
function batches(texts: string[]): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (group.length > 0 && (group.length === MICROSOFT_MAX_TEXTS || chars + text.length > MICROSOFT_MAX_CHARS)) {
      groups.push(group);
      group = [];
      chars = 0;
    }
    group.push(text);
    chars += text.length;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function microsoftText(entry: unknown): string | null {
  const first: unknown = isRecord(entry) && Array.isArray(entry.translations) ? entry.translations[0] : null;
  return isRecord(first) && typeof first.text === "string" ? first.text : null;
}

/** One request: the texts go as a JSON list, and come back as [{ translations: [{ text }] }, ...] in the same order. */
async function microsoft(texts: string[], lang: LangCode, options: EngineOptions): Promise<string[]> {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(texts) };
  const body = await ask("microsoft", `${MICROSOFT}?from=en&to=${lang}`, init, options);
  const translations = Array.isArray(body) && body.length === texts.length ? body.map(microsoftText) : [];
  const made = translations.filter((text) => text !== null);
  if (made.length !== texts.length) throw new TranslationError("Microsoft answered with something that is not a translation of each paragraph");
  return made;
}

/** `text` in pieces of at most `max` characters, each cut after the end of a sentence, else at a space, else anywhere. */
function splitAtSentences(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    // One character more than fits: a space just past the limit is a place to cut too, and trimming takes it away.
    const window = rest.slice(0, max + 1);
    let cut = 0;
    // A sentence ends at . ! or ?, after any closing quotes (straight or curly) and brackets.
    for (const end of window.matchAll(/[.!?]["'\u201D\u2019)\]]*\s+/g)) cut = end.index + end[0].length;
    if (cut === 0) cut = window.lastIndexOf(" ") + 1;
    if (cut === 0) cut = max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== "") pieces.push(rest);
  return pieces;
}

/** One request: the text goes in the address, and comes back as [[["piece", "source", ...], ...], ...], cut at sentences. */
async function googlePiece(text: string, lang: LangCode, options: EngineOptions): Promise<string> {
  const body = await ask("google", `${GOOGLE}?client=gtx&sl=en&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`, {}, options);
  const rows: unknown[] = Array.isArray(body) && Array.isArray(body[0]) ? body[0] : [];
  // A row without text is not part of the translation (a transliteration, when one is sent).
  const pieces = rows.map((row) => (Array.isArray(row) && typeof row[0] === "string" ? row[0] : null)).filter((piece) => piece !== null);
  if (pieces.length === 0) throw new TranslationError("Google answered with something that is not a translation");
  return pieces.join("").trim();
}

/** `work` on every item, `limit` at a time, in order. After the first failure no more start, and it is the answer. */
async function inTurns<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const at = next;
      next += 1;
      try {
        results[at] = await work(items[at] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Google, a paragraph a request: a long one goes in pieces cut at sentence ends, and its translations are joined again. */
async function google(texts: string[], lang: LangCode, options: EngineOptions): Promise<string[]> {
  const pieces = texts.flatMap((text, at) => splitAtSentences(text, GOOGLE_MAX_CHARS).map((piece) => ({ at, piece })));
  const made = await inTurns(pieces, GOOGLE_AT_ONCE, ({ piece }) => googlePiece(piece, lang, options));
  const joined: string[][] = texts.map(() => []);
  pieces.forEach(({ at }, piece) => joined[at]?.push(made[piece] ?? ""));
  return joined.map((parts) => parts.join(" "));
}

const by = (engine: Service, texts: string[]): Translated[] => texts.map((text) => ({ text, engine }));

/** One batch with `engine`: under auto, Google translates what Microsoft cannot. */
async function translateBatch(batch: string[], lang: LangCode, engine: TranslationEngine, options: EngineOptions): Promise<Translated[]> {
  if (engine === "google") return by("google", await google(batch, lang, options));
  try {
    return by("microsoft", await microsoft(batch, lang, options));
  } catch (error) {
    if (engine === "microsoft" || !(error instanceof TranslationError)) throw error;
    try {
      return by("google", await google(batch, lang, options));
    } catch (fallback) {
      if (!(fallback instanceof TranslationError)) throw fallback;
      throw new TranslationError(`${error.message}; ${fallback.message}`);
    }
  }
}

/** English `texts` in `lang`, in order. Throws TranslationError when the services cannot translate them. */
export async function translateTexts(texts: string[], lang: LangCode, engine: TranslationEngine, options: EngineOptions = {}): Promise<Translated[]> {
  const made: Translated[] = [];
  // One batch at a time: a chapter is rarely more than one, and Google, when it stands in, already sends several at once.
  for (const batch of batches(texts)) made.push(...(await translateBatch(batch, lang, engine, options)));
  return made;
}

/** Where a book's translations are kept: with the book in its owner's library, so everyone who reads it shares them. */
export type TranslationHome = { library: Pick<Library, "readTranslation" | "writeTranslation">; bookId: string };

/** A block's translation as it is kept: `source` is the fingerprint of the text it was made from. */
type Kept = Translated & { source: string };

const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, FINGERPRINT_CHARS);

/** The blocks a kept translation holds, by block id. Anything that is not one is left out, and so translated again. */
function readKept(value: unknown): Map<string, Kept> {
  const kept = new Map<string, Kept>();
  const blocks = isRecord(value) && isRecord(value.blocks) ? value.blocks : {};
  for (const [id, entry] of Object.entries(blocks)) {
    if (!isRecord(entry) || typeof entry.source !== "string" || typeof entry.text !== "string") continue;
    if (entry.engine === "microsoft" || entry.engine === "google") kept.set(id, { source: entry.source, text: entry.text, engine: entry.engine });
  }
  return kept;
}

/** The service that made most of `sent`; with nothing sent, the one `engine` asks first. */
function mostlyBy(sent: Kept[], engine: TranslationEngine): Service {
  if (sent.length === 0) return engine === "google" ? "google" : "microsoft";
  return sent.filter((one) => one.engine === "google").length * 2 > sent.length ? "google" : "microsoft";
}

export type ChapterTranslator = {
  /**
   * The chapter's blocks in `lang`, by block id: what is kept with the book, and the blocks missing from it or changed
   * since translated now with `engine` and kept too. Blank blocks are left out. Throws TranslationError when the
   * services cannot translate what is missing.
   */
  chapter(home: TranslationHome, chapter: Chapter, lang: LangCode, engine: TranslationEngine): Promise<ChapterTranslation>;
  /** Translates TRANSLATION_SAMPLE with `engine`, and says how it went. Never rejects. */
  test(lang: LangCode, engine: TranslationEngine): Promise<TranslationTest>;
};

export function createChapterTranslator(options: EngineOptions = {}): ChapterTranslator {
  // By library, then book, language and chapter: two readers opening the same chapter at once share one translation.
  const running = new WeakMap<object, Map<string, Promise<ChapterTranslation>>>();

  async function translate(home: TranslationHome, chapter: Chapter, lang: LangCode, engine: TranslationEngine): Promise<ChapterTranslation> {
    const kept = readKept(await home.library.readTranslation(home.bookId, lang, chapter.id));
    // A blank block has nothing to translate, and a service would only stumble on it.
    const blocks = chapter.blocks.filter((block) => block.text.trim() !== "");
    const missing = blocks.filter((block) => kept.get(block.id)?.source !== fingerprint(block.text));
    if (missing.length > 0) {
      const made = await translateTexts(missing.map((block) => block.text), lang, engine, options);
      missing.forEach((block, at) => {
        const one = made[at];
        if (one) kept.set(block.id, { ...one, source: fingerprint(block.text) });
      });
      // The chapter's blocks as they are now: a block the book no longer has goes.
      const value = { blocks: Object.fromEntries(blocks.map((block) => [block.id, kept.get(block.id)])) };
      await home.library.writeTranslation(home.bookId, lang, chapter.id, value);
    }
    const sent = blocks.map((block) => [block.id, kept.get(block.id)] as const).filter((pair): pair is readonly [string, Kept] => pair[1] !== undefined);
    return { lang, blocks: Object.fromEntries(sent.map(([id, one]) => [id, one.text])), engine: mostlyBy(sent.map(([, one]) => one), engine) };
  }

  return {
    chapter(home, chapter, lang, engine) {
      const inLibrary = running.get(home.library) ?? new Map<string, Promise<ChapterTranslation>>();
      running.set(home.library, inLibrary);
      const key = `${home.bookId}\n${lang}\n${chapter.id}`;
      const under = inLibrary.get(key);
      if (under) return under;
      const work = translate(home, chapter, lang, engine).finally(() => inLibrary.delete(key));
      inLibrary.set(key, work);
      return work;
    },

    async test(lang, engine) {
      const started = performance.now();
      try {
        const [made] = await translateTexts([TRANSLATION_SAMPLE], lang, engine, options);
        if (!made) throw new TranslationError("nothing came back");
        return { ok: true, engine: made.engine, ms: Math.round(performance.now() - started), sample: TRANSLATION_SAMPLE, translation: made.text };
      } catch (error) {
        const who = engine === "auto" ? "Neither Microsoft nor Google could" : `${NAMES[engine]} could not`;
        return { ok: false, message: `${who} translate the sample sentence from this computer: ${error instanceof Error ? error.message : String(error)}.` };
      }
    },
  };
}

/** What chapter translation needs, made once in index.ts: the admin's choice, and the services that translate. */
export type Translation = { settings: TranslationSettingsStore; translator: ChapterTranslator };

/** The admin's choice for chapter translation, which holds for every reader. */
export type TranslationSettingsStore = {
  /** What the admin chose, or the defaults until they choose: translation on, with auto. */
  get(): TranslationSettings;
  /** Keeps what the admin chose; the caller has checked the fields. */
  save(patch: Partial<TranslationSettings>): Promise<TranslationSettings>;
};

/** What the file holds, field by field; a field that is missing or makes no sense is the default. */
function readSettings(file: string): TranslationSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) console.warn(`${SETTINGS_FILE} is unreadable, so translation starts as it does by default:`, error);
    return DEFAULT_SETTINGS;
  }
  const saved = isRecord(parsed) ? parsed : {};
  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_SETTINGS.enabled,
    engine: isTranslationEngine(saved.engine) ? saved.engine : DEFAULT_SETTINGS.engine,
  };
}

export function createTranslationSettings(dataDir: string): TranslationSettingsStore {
  const file = join(dataDir, SETTINGS_FILE);
  // Only this process writes the file, so what is in memory is what is on disk.
  let current = readSettings(file);
  // One save at a time, so a slow disk cannot let an older choice land last.
  let saving: Promise<unknown> = Promise.resolve();
  return {
    get: () => current,
    save(patch) {
      const run = saving.then(async () => {
        const next = { ...current, ...patch };
        await mkdir(dataDir, { recursive: true });
        await writeFileAtomic(file, `${JSON.stringify(next)}\n`);
        current = next;
        return next;
      });
      saving = run.catch(() => {});
      return run;
    },
  };
}
