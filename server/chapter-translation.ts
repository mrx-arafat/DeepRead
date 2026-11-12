// A whole chapter in the reader's language, paragraph by paragraph, kept with the book so every reader and device reuses it.
// Two ways make it. The reader's AI helper reads the book around each paragraph, in batches of consecutive paragraphs, and
// writes what a published edition would say (ai-translation.ts); it takes minutes for a chapter, so the paragraphs done so
// far are shown while the rest are made. A keyless public service is instant and free but works a paragraph at a time with
// no memory of the book: Microsoft's Edge endpoint answers first, Google's gtx endpoint stands in when it cannot, and the
// admin may choose either alone. Both are unofficial, so any request can fail: each has a timeout, and a failure is a
// TranslationError with a short reason for the server log, never a translation.
// Under Automatic the AI helper comes first and the services stand in for it when the reader has none, or it fails.
// Each block is translated once by whatever makes it. The translation is kept with the book (library.ts), beside a fingerprint
// of the block's text and what made it, so a book parsed again has only the blocks that changed translated again, and a block
// a service made is made again by an AI helper the next time a reader who has one opens the chapter.
// The admin's choice, whether readers may and which engine translates, is kept in <dataDir>/translation.json.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TRANSLATION_ENGINES } from "../shared/types.ts";
import type { Block, Chapter, ChapterTranslation, LangCode, TranslationEngine, TranslationMaker, TranslationSettings, TranslationTest } from "../shared/types.ts";
import { AI_AT_ONCE, CONTEXT_CHARS, CONTEXT_PARAGRAPHS, isProse, planBatches, translateBatch } from "./ai-translation.ts";
import type { AiBook, AiContext } from "./ai-translation.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { isRecord } from "./http.ts";
import type { Library } from "./library.ts";
import { createGate, LlmError } from "./llm.ts";
import type { Llm } from "./llm.ts";
import type { StyleKeeper } from "./translation-style.ts";

const MICROSOFT = "https://edge.microsoft.com/translate/translatetext";
const GOOGLE = "https://translate.googleapis.com/translate_a/single";
// Measured: 60 paragraphs (18,000 characters) came back in 0.6 s, so a chapter is usually one request.
const MICROSOFT_MAX_TEXTS = 100;
const MICROSOFT_MAX_CHARS = 40_000;
// A chapter of 200 short paragraphs is three requests: one after another they took 3.3 s, side by side about one.
const MICROSOFT_AT_ONCE = 3;
// Google takes the text in the address, which it refuses past a length: a longer paragraph goes in pieces.
const GOOGLE_MAX_CHARS = 4_500;
// Google takes one paragraph a request and is quick to suspect a robot, so only a few go at once.
const GOOGLE_AT_ONCE = 4;
const TIMEOUT_MS = 15_000;
const FINGERPRINT_CHARS = 16;
const SETTINGS_FILE = "translation.json";
// After an AI helper fails a reader twice in a row within one chapter, or is not installed or not signed in, the services
// translate the rest of that chapter, and the helper is left alone for this long before the next chapter tries it again: a
// helper that is down must not make every chapter wait for its timeout.
const AI_COOL_OFF_MS = 3 * 60_000;
const AI_FAILURES_TO_GIVE_UP = 2;

/** What the admin's test translates: a plain sentence with a clause in the middle, as books have. */
export const TRANSLATION_SAMPLE = "The real table, if it exists, we will call a physical object.";

const DEFAULT_SETTINGS: TranslationSettings = { enabled: true, engine: "auto" };

/** A free public service that makes translations. */
type Service = Exclude<TranslationMaker, "ai">;

/** The engines that are services alone: no AI helper takes part. */
type ServiceEngine = Exclude<TranslationEngine, "ai">;

const NAMES: Record<Service, string> = { microsoft: "Microsoft", google: "Google" };

/**
 * A service could not translate. The message is a short reason for the server log, like "Google answered 302". When a
 * reader can act on the reason (the AI helper is not theirs, or they are over its daily limit), `readerMessage` says it
 * for them; without it they are told to try again.
 */
export class TranslationError extends Error {
  readonly readerMessage: string | undefined;

  constructor(message: string, readerMessage?: string) {
    super(message);
    this.name = "TranslationError";
    this.readerMessage = readerMessage;
  }
}

export type EngineOptions = {
  /** Replaceable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** How long one request may take. */
  timeoutMs?: number;
  /** The clock, for tests of how long an AI helper is left alone after it fails. */
  now?: () => number;
};

/** One translation by a free service, and which. */
export type Translated = { text: string; engine: Service };

/** The AI helper that translates for one reader, and what it is told of the book. */
export type AiHelp = {
  llm: Llm;
  /** Who it answers for: its failures count against them alone, not against the helper for everyone. */
  who: string;
  book: AiBook;
  /**
   * The book's translator's notes (translation-style.ts) for a passage: the names, terms and forms of address of the people
   * in it, as a few lines of text, or "" when there are none. Asked for once per batch with the batch and the paragraphs
   * before it, so a batch gets the notes of the people who speak in it.
   */
  notes?: (passage: string) => Promise<string>;
};

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
  // A blank answer for a paragraph that has words is a failure, not a translation to keep.
  if (made.some((text, at) => text.trim() === "" && (texts[at] ?? "").trim() !== "")) throw new TranslationError("Microsoft answered with a blank translation");
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
  const made = pieces.join("").trim();
  if (pieces.length === 0 || (made === "" && text.trim() !== "")) throw new TranslationError("Google answered with something that is not a translation");
  return made;
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

/** One batch from Microsoft. Under auto its failure comes back instead of being thrown, so Google can stand in for it. */
async function fromMicrosoft(batch: string[], lang: LangCode, engine: ServiceEngine, options: EngineOptions): Promise<string[] | TranslationError> {
  try {
    return await microsoft(batch, lang, options);
  } catch (error) {
    if (engine === "microsoft" || !(error instanceof TranslationError)) throw error;
    return error;
  }
}

/** Google, for a batch Microsoft could not translate; when Google cannot either, the failure names both. */
async function googleInstead(batch: string[], lang: LangCode, refused: TranslationError, options: EngineOptions): Promise<Translated[]> {
  try {
    return by("google", await google(batch, lang, options));
  } catch (fallback) {
    if (!(fallback instanceof TranslationError)) throw fallback;
    throw new TranslationError(`${refused.message}; ${fallback.message}`);
  }
}

/** English `texts` in `lang`, in order. Throws TranslationError when the services cannot translate them. */
export async function translateTexts(texts: string[], lang: LangCode, engine: ServiceEngine, options: EngineOptions = {}): Promise<Translated[]> {
  const groups = batches(texts);
  const made: Translated[] = [];
  // Google goes one batch at a time, here and when it stands in below: it already sends several requests at once.
  if (engine === "google") {
    for (const batch of groups) made.push(...by("google", await google(batch, lang, options)));
    return made;
  }
  const tried = await inTurns(groups, MICROSOFT_AT_ONCE, (batch) => fromMicrosoft(batch, lang, engine, options));
  for (const [at, batch] of groups.entries()) {
    const result = tried[at] ?? new TranslationError("Microsoft sent nothing back");
    made.push(...(result instanceof TranslationError ? await googleInstead(batch, lang, result, options) : by("microsoft", result)));
  }
  return made;
}

/** Where a book's translations are kept: with the book in its owner's library, so everyone who reads it shares them. */
export type TranslationHome = { library: Pick<Library, "readTranslation" | "writeTranslation">; bookId: string };

/** A block's translation as it is kept: `source` is the fingerprint of the text it was made from. */
type Kept = {
  text: string;
  engine: TranslationMaker;
  source: string;
  /** An AI helper was asked for this text and its answer was refused, so a service made it: the helper is not asked again. */
  aiTried?: true;
};

const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, FINGERPRINT_CHARS);

const MAKERS: readonly TranslationMaker[] = ["ai", "microsoft", "google"];

/** The blocks a kept translation holds, by block id. Anything that is not one is left out, and so translated again. */
function readKept(value: unknown): Map<string, Kept> {
  const kept = new Map<string, Kept>();
  const blocks = isRecord(value) && isRecord(value.blocks) ? value.blocks : {};
  for (const [id, entry] of Object.entries(blocks)) {
    if (!isRecord(entry) || typeof entry.source !== "string" || typeof entry.text !== "string" || entry.text.trim() === "") continue;
    const engine = MAKERS.find((maker) => maker === entry.engine);
    if (engine) kept.set(id, { source: entry.source, text: entry.text, engine, ...(entry.aiTried === true && { aiTried: true as const }) });
  }
  return kept;
}

/** What made most of `sent`, the AI helper before Microsoft before Google on a tie; with nothing sent, what `engine` asks first. */
function mostlyBy(sent: Kept[], engine: TranslationEngine, askedAi: boolean): TranslationMaker {
  if (sent.length === 0) return engine === "google" ? "google" : engine === "microsoft" || !askedAi ? "microsoft" : "ai";
  let best: TranslationMaker = "microsoft";
  let most = -1;
  for (const maker of MAKERS) {
    const count = sent.filter((one) => one.engine === maker).length;
    if (count > most) [best, most] = [maker, count];
  }
  return best;
}

export type ChapterTranslator = {
  /**
   * The chapter's blocks in `lang`, by block id: what is kept with the book, and the blocks missing from it or changed
   * since translated now with `engine` and kept too. Blank blocks are left out. With `ai`, the AI helper translates the
   * prose, a few paragraphs at a time, and this answers as soon as the first of them is done, with `complete: false` until
   * the rest are; ask again for those. Throws TranslationError when nothing can translate what is missing.
   */
  chapter(home: TranslationHome, chapter: Chapter, lang: LangCode, engine: TranslationEngine, ai?: AiHelp): Promise<ChapterTranslation>;
  /** Translates TRANSLATION_SAMPLE with `engine`, and says how it went. Never rejects. */
  test(lang: LangCode, engine: TranslationEngine, ai?: AiHelp): Promise<TranslationTest>;
};

/** One going-over of a chapter's missing blocks, which every request for the chapter joins while it lasts. */
type Run = {
  /** Whether an AI helper translates (and so the answer is given in parts), or the services alone. */
  mode: "ai" | "plain";
  /** Whose helper the run uses; null for the services alone. */
  who: string | null;
  /** The blocks the run has yet to make: a translation kept for one of them is out of date, and not shown meanwhile. */
  pending: Set<string>;
  /** What is kept for the chapter, as the run last read or wrote it. */
  kept: Map<string, Kept>;
  /** How many times the chapter's file had been written when `kept` was last in step with it. */
  syncedAt: number;
  /** Nothing was missing, so nothing was made. */
  clean: boolean;
  /** Enough is done to answer: the first batch of an AI run, or all of a plain one. */
  ready: boolean;
  settled: boolean;
  error: Error | null;
  waiters: Array<() => void>;
  done: Promise<void>;
};

const NO_HELPER = "Translating a chapter with the AI helper needs one. Ask the admin for an AI helper, or to choose another way to translate.";

export function createChapterTranslator(options: EngineOptions = {}): ChapterTranslator {
  const now = options.now ?? Date.now;
  // By library, then book, language and chapter: two readers opening the same chapter at once share one translation.
  const running = new WeakMap<object, Map<string, Run>>();
  // The last answer read whole from the book, by parsed chapter and language: reading it again means decoding, parsing and
  // fingerprinting a file as big as the chapter. It holds while the book's file does, and only this translator writes
  // that file (writeTranslation), which drops it. A removed book is forgotten by its library with its parsed chapters,
  // and a book added again is parsed again, so no request after a removal reaches an answer kept here.
  const answers = new WeakMap<Chapter, Map<LangCode, { library: object; bookId: string; engine: TranslationEngine; mode: Run["mode"]; answer: ChapterTranslation }>>();
  // The writes to one chapter's file, one after another: a run writes after every batch, and a reader's request can make a
  // second run for the same chapter, so each write reads the file again and adds to it rather than replacing it.
  const writing = new WeakMap<object, Map<string, Promise<unknown>>>();
  // How many times each chapter's file has been written, so a run can tell that no one wrote it since it last read it.
  const writes = new WeakMap<object, Map<string, number>>();
  // When each reader's AI helper may be asked again, after it failed them.
  const coolOff = new Map<string, number>();
  const gate = createGate(AI_AT_ONCE);

  const coolingOff = (ai: AiHelp): boolean => (coolOff.get(ai.who) ?? 0) > now();

  /** Translate with an AI helper only for a reader who has one, and, under Automatic, while it has not just failed them. */
  function modeOf(engine: TranslationEngine, ai: AiHelp | undefined): Run["mode"] {
    if (!ai || engine === "microsoft" || engine === "google") return "plain";
    return engine === "ai" || !coolingOff(ai) ? "ai" : "plain";
  }

  /** The blocks that have words to translate: a figure's has none, and a blank block would only stumble a service. */
  const readable = (chapter: Chapter): Block[] => chapter.blocks.filter((block) => block.text.trim() !== "");

  /** Prose is the AI helper's to translate. Code, tables and the like are not, and go to the services as they always have. */
  const proseBlock = (block: Block): boolean => (block.type === "heading" || block.type === "paragraph") && isProse(block.text);

  function serialized<T>(library: object, key: string, work: () => Promise<T>): Promise<T> {
    const inLibrary = writing.get(library) ?? new Map<string, Promise<unknown>>();
    writing.set(library, inLibrary);
    const result = (inLibrary.get(key) ?? Promise.resolve()).then(work, work);
    const tail = result.then(() => {}, () => {});
    inLibrary.set(key, tail);
    void tail.then(() => {
      if (inLibrary.get(key) === tail) inLibrary.delete(key);
    });
    return result;
  }

  const wake = (run: Run): void => {
    for (const waiter of run.waiters.splice(0)) waiter();
  };

  /**
   * Keeps `entries` with the book, on top of whatever the file holds now, and takes `resolved` off what the run has yet to
   * make. A translation by a service never replaces one by the AI helper for the same text.
   */
  async function commit(run: Run, home: TranslationHome, chapter: Chapter, lang: LangCode, entries: Array<[string, Kept]>, resolved: Iterable<string>): Promise<void> {
    const key = `${home.bookId}\n${lang}\n${chapter.id}`;
    if (entries.length > 0) {
      await serialized(home.library, key, async () => {
        const counts = writes.get(home.library) ?? new Map<string, number>();
        writes.set(home.library, counts);
        const written = counts.get(key) ?? 0;
        // The file is read again only when another run has written it since this one did.
        const fresh = run.syncedAt === written ? new Map(run.kept) : readKept(await home.library.readTranslation(home.bookId, lang, chapter.id));
        for (const [id, entry] of entries) {
          const had = fresh.get(id);
          if (had?.engine === "ai" && had.source === entry.source && entry.engine !== "ai") continue;
          fresh.set(id, entry);
        }
        // The chapter's blocks as they are now: a block the book no longer has goes.
        const value = { blocks: Object.fromEntries(readable(chapter).map((block) => [block.id, fresh.get(block.id)])) };
        answers.get(chapter)?.delete(lang);
        await home.library.writeTranslation(home.bookId, lang, chapter.id, value);
        counts.set(key, written + 1);
        run.syncedAt = written + 1;
        run.kept = fresh;
      });
    }
    for (const id of resolved) run.pending.delete(id);
  }

  /** The paragraphs just before `block`, for the AI helper to read: with their translation where the edition has one by it. */
  function contextFor(run: Run, blocks: Block[], block: Block): AiContext[] {
    const before: AiContext[] = [];
    let chars = 0;
    for (let at = blocks.indexOf(block) - 1; at >= 0 && before.length < CONTEXT_PARAGRAPHS; at -= 1) {
      const one = blocks[at];
      // One paragraph bigger than all the context allowed is left out; the ones before it still show.
      if (!one || !proseBlock(one) || one.text.length > CONTEXT_CHARS) continue;
      if (chars + one.text.length > CONTEXT_CHARS) break;
      chars += one.text.length;
      const had = run.kept.get(one.id);
      const made = had?.engine === "ai" && had.source === fingerprint(one.text) && !run.pending.has(one.id);
      before.unshift({ text: one.text, ...(made && { translation: had.text }) });
    }
    return before;
  }

  const entryFrom = (block: Block, made: Translated, refused: boolean): [string, Kept] => [
    block.id,
    { text: made.text, engine: made.engine, source: fingerprint(block.text), ...(refused && { aiTried: true as const }) },
  ];

  /** The free services alone, all the missing blocks at once. */
  async function workWithServices(run: Run, home: TranslationHome, chapter: Chapter, lang: LangCode, engine: TranslationEngine, todo: Block[]): Promise<void> {
    if (engine === "ai") throw new TranslationError("the AI helper was chosen to translate, and this reader has none", NO_HELPER);
    const made = await translateTexts(todo.map((block) => block.text), lang, engine, options);
    await commit(run, home, chapter, lang, todo.flatMap((block, at) => (made[at] ? [entryFrom(block, made[at], false)] : [])), todo.map((block) => block.id));
  }

  /**
   * The prose with the AI helper, a batch of consecutive paragraphs at a time and in order, each read with the paragraphs
   * before it. Every batch is kept as soon as it is made. Under Automatic a paragraph the helper cannot make is made by the
   * services; after two failed batches in a row, or a helper that is missing or signed out, the services make the rest and
   * the helper is left alone for a while. When the AI helper alone was chosen, a failure ends the run, with what was made kept.
   */
  async function workWithAi(run: Run, home: TranslationHome, chapter: Chapter, lang: LangCode, engine: TranslationEngine, ai: AiHelp, todo: Block[], blocks: Block[]): Promise<void> {
    const strict = engine === "ai";
    const prose = todo.filter(proseBlock);
    const rest = todo.filter((block) => !proseBlock(block));
    // Code, tables and the like go to the services. If they cannot, the prose is still made and kept, and then the run fails
    // as a run by the services alone does: a chapter is never called whole with a block missing.
    let restFailure: TranslationError | null = null;
    if (rest.length > 0) {
      try {
        const made = await translateTexts(rest.map((block) => block.text), lang, "auto", options);
        await commit(run, home, chapter, lang, rest.flatMap((block, at) => (made[at] ? [entryFrom(block, made[at], false)] : [])), rest.map((block) => block.id));
      } catch (error) {
        if (!(error instanceof TranslationError)) throw error;
        console.warn(`translating the code and tables of a chapter failed: ${error.message}`);
        restFailure = error;
      }
    }
    let failures = 0;
    let down = false;
    for (const batch of planBatches(prose)) {
      const entries: Array<[string, Kept]> = [];
      const refused = new Map<string, string>();
      let missing: Block[] = batch;
      let stopped: TranslationError | null = null;
      if (!down) {
        const release = await gate.acquire();
        try {
          const first = batch[0];
          const before = first ? contextFor(run, blocks, first) : [];
          // The notes of the people in this batch, found from what they say and what is said of them in the paragraphs before.
          const notes = (await ai.notes?.([...before.map((one) => one.text), ...batch.map((one) => one.text)].join("\n\n"))) ?? "";
          const result = await translateBatch({
            llm: ai.llm,
            lang,
            book: ai.book,
            chapterTitle: chapter.title,
            ...(notes && { style: notes }),
            before,
            paragraphs: batch.map(({ id, text }) => ({ id, text })),
          });
          // What the first answer got right is kept even when the second question failed.
          for (const block of batch) {
            const text = result.made.get(block.id);
            if (text !== undefined) entries.push([block.id, { text, engine: "ai", source: fingerprint(block.text) }]);
          }
          missing = batch.filter((block) => !result.made.has(block.id));
          for (const [id, why] of result.failed) refused.set(id, why);
          if (refused.size > 0) console.warn(`the AI helper's translation of ${refused.size} paragraph(s) was refused: ${[...refused.values()][0]}`);
          if (result.error) throw result.error;
          failures = 0;
        } catch (error) {
          if (!(error instanceof LlmError)) throw error;
          failures += 1;
          console.warn(`the AI helper could not translate a batch of a chapter: ${error.message}`);
          if (strict) stopped = new TranslationError(`the AI helper could not translate: ${error.message}`, error.message);
          else if (failures >= AI_FAILURES_TO_GIVE_UP || error.kind === "cli_missing" || error.kind === "not_logged_in") {
            down = true;
            coolOff.set(ai.who, now() + AI_COOL_OFF_MS);
          }
        } finally {
          release();
        }
      }
      if (missing.length > 0 && !stopped) {
        if (strict) {
          stopped = new TranslationError(
            `the AI helper's translation of ${missing.length} paragraph(s) was refused: ${[...refused.values()][0] ?? "no answer"}`,
            "The AI helper could not translate part of this chapter just now. Please try again.",
          );
        } else {
          try {
            const made = await translateTexts(missing.map((block) => block.text), lang, "auto", options);
            missing.forEach((block, at) => {
              if (made[at]) entries.push(entryFrom(block, made[at], refused.has(block.id)));
            });
          } catch (error) {
            // What the helper did make is kept before the failure is told.
            await commit(run, home, chapter, lang, entries, batch.map((block) => block.id));
            throw error;
          }
        }
      }
      await commit(run, home, chapter, lang, entries, batch.map((block) => block.id));
      if (stopped) throw stopped;
      run.ready = true;
      wake(run);
    }
    if (restFailure) throw restFailure;
  }

  async function work(run: Run, home: TranslationHome, chapter: Chapter, lang: LangCode, engine: TranslationEngine, ai: AiHelp | undefined): Promise<void> {
    run.syncedAt = writes.get(home.library)?.get(`${home.bookId}\n${lang}\n${chapter.id}`) ?? 0;
    run.kept = readKept(await home.library.readTranslation(home.bookId, lang, chapter.id));
    const blocks = readable(chapter);
    // Under an AI helper a block a service made is made again, unless the helper has already failed at that very text.
    const upgrade = run.mode === "ai";
    const todo = blocks.filter((block) => {
      const had = run.kept.get(block.id);
      if (had?.source !== fingerprint(block.text)) return true;
      return upgrade && proseBlock(block) && had.engine !== "ai" && !had.aiTried;
    });
    run.pending = new Set(todo.map((block) => block.id));
    if (todo.length === 0) {
      run.clean = true;
      return;
    }
    if (run.mode === "ai" && ai) await workWithAi(run, home, chapter, lang, engine, ai, todo, blocks);
    else await workWithServices(run, home, chapter, lang, engine, todo);
  }

  /** Starts the run for a chapter and puts it where every request for the chapter will find it. */
  function begin(inLibrary: Map<string, Run>, key: string, home: TranslationHome, chapter: Chapter, lang: LangCode, engine: TranslationEngine, ai: AiHelp | undefined, mode: Run["mode"]): Run {
    const run: Run = { mode, who: mode === "ai" ? (ai?.who ?? null) : null, pending: new Set(), kept: new Map(), syncedAt: 0, clean: false, ready: false, settled: false, error: null, waiters: [], done: Promise.resolve() };
    inLibrary.set(key, run);
    run.done = work(run, home, chapter, lang, engine, ai)
      .catch((error: unknown) => {
        run.error = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        run.settled = true;
        run.ready = true;
        if (inLibrary.get(key) === run) inLibrary.delete(key);
        wake(run);
      });
    return run;
  }

  function answerOf(run: Run, home: TranslationHome, chapter: Chapter, lang: LangCode, engine: TranslationEngine): ChapterTranslation {
    const sent = readable(chapter)
      .filter((block) => !run.pending.has(block.id))
      .map((block) => [block.id, run.kept.get(block.id)] as const)
      .filter((pair): pair is readonly [string, Kept] => pair[1] !== undefined);
    // The last batch is kept before the run is over: with nothing left to make, the chapter is whole.
    const complete = run.settled || run.pending.size === 0;
    // Shared by every request that finds it kept, so nobody may change it.
    const answer: ChapterTranslation = Object.freeze({
      lang,
      blocks: Object.freeze(Object.fromEntries(sent.map(([id, one]) => [id, one.text]))),
      engine: mostlyBy(sent.map(([, one]) => one), engine, run.mode === "ai"),
      ...(!complete && { complete: false }),
    });
    // Only an answer the book's file held whole: one just written is read back once, so what is kept is what the book has.
    if (run.clean) {
      let byLang = answers.get(chapter);
      if (!byLang) answers.set(chapter, (byLang = new Map()));
      byLang.set(lang, { library: home.library, bookId: home.bookId, engine, mode: run.mode, answer });
    }
    return answer;
  }

  return {
    async chapter(home, chapter, lang, engine, ai) {
      const mode = modeOf(engine, ai);
      let ownTurn = false;
      for (;;) {
        const known = answers.get(chapter)?.get(lang);
        if (known?.library === home.library && known.bookId === home.bookId && known.engine === engine && known.mode === mode) return known.answer;
        const inLibrary = running.get(home.library) ?? new Map<string, Run>();
        running.set(home.library, inLibrary);
        const key = `${home.bookId}\n${lang}\n${chapter.id}`;
        let run = inLibrary.get(key);
        // A run by the services is over in a moment. A reader who has an AI helper waits for it, and then has the chapter
        // made again by their helper, which makes what the services made better.
        if (run?.mode === "plain" && mode === "ai") {
          await run.done;
          continue;
        }
        const joined = run ?? begin(inLibrary, key, home, chapter, lang, engine, ai, mode);
        if (!joined.ready) await new Promise<void>((resolve) => joined.waiters.push(resolve));
        if (joined.error) {
          // A run that failed on another reader's helper (their daily limit, their sign-in) says nothing of this reader's own:
          // it is made again, once, with theirs.
          if (run && !ownTurn && mode === "ai" && ai && joined.who !== ai.who) {
            ownTurn = true;
            continue;
          }
          throw joined.error;
        }
        return answerOf(joined, home, chapter, lang, engine);
      }
    },

    async test(lang, engine, ai) {
      const started = performance.now();
      const took = () => Math.round(performance.now() - started);
      if (engine === "ai" || (engine === "auto" && ai && !coolingOff(ai))) {
        try {
          if (!ai) throw new TranslationError(NO_HELPER);
          const result = await translateBatch({ llm: ai.llm, lang, book: { title: "A sample sentence", author: null }, chapterTitle: "Sample", before: [], paragraphs: [{ id: "sample", text: TRANSLATION_SAMPLE }] });
          const text = result.made.get("sample");
          if (text !== undefined) return { ok: true, engine: "ai", ms: took(), sample: TRANSLATION_SAMPLE, translation: text };
          throw new TranslationError(`its answer was refused: ${result.failed.get("sample") ?? "no answer"}`);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          if (engine === "ai") return { ok: false, message: `The AI helper could not translate the sample sentence: ${why}.` };
          // Under Automatic the services carry on, as they do for a chapter.
        }
      }
      try {
        const [made] = await translateTexts([TRANSLATION_SAMPLE], lang, engine, options);
        if (!made) throw new TranslationError("nothing came back");
        return { ok: true, engine: made.engine, ms: took(), sample: TRANSLATION_SAMPLE, translation: made.text };
      } catch (error) {
        const who = engine === "microsoft" || engine === "google" ? `${NAMES[engine]} could not` : "Neither Microsoft nor Google could";
        return { ok: false, message: `${who} translate the sample sentence from this computer: ${error instanceof Error ? error.message : String(error)}.` };
      }
    },
  };
}

/** What chapter translation needs, made once in index.ts: the admin's choice, and the services that translate. `styles` replaces the shared keeper of the books' translator's notes (tests). */
export type Translation = { settings: TranslationSettingsStore; translator: ChapterTranslator; styles?: StyleKeeper };

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
