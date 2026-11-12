// Chapter translation over HTTP: a chapter in the reader's language, whether this reader may have one, and the admin's
// side: whether readers may, which service translates, and a try of that service on one sentence.
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TRANSLATION_ENGINES } from "../shared/types.ts";
import type { Chapter, LangCode, ParsedBook, TranslationSettings } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import type { AppEnv } from "./app-env.ts";
import { isTranslationEngine, TranslationError } from "./chapter-translation.ts";
import type { AiHelp, Translation } from "./chapter-translation.ts";
import type { Accounts } from "./deps.ts";
import { adminOnly, apiError, bookNotFound, chapterNotFound, invalidBody, invalidId, isLangCode, LANG_HELP, readJsonObject } from "./http.ts";
import { jsonBody, sendJsonBody } from "./routes-books.ts";
import type { JsonBody } from "./routes-books.ts";
import { isReadableBookId, parseSharedBookId } from "./shares.ts";
import type { Library } from "./library.ts";
import { accessOf } from "./routes-ai.ts";
import { bookStyles, styleNotes } from "./translation-style.ts";
import type { StyleKeeper } from "./translation-style.ts";

const SETTINGS_HELP = 'send JSON like {"enabled": true, "engine": "auto"}.';

/**
 * Whether this reader may have a chapter translated: unless the admin turned it off for readers. The admin always may, also
 * while viewing as someone else, and without profiles there is nobody to turn it off for.
 */
function mayTranslate(c: Context<AppEnv>, settings: TranslationSettings): boolean {
  const { session } = c.var;
  return session === null || settings.enabled || session.actor.admin;
}

// A chapter's latest translation in each language, as sent: with its tag and its gzip, which are made once rather than on
// every request. Keyed by the parsed chapter like the chapter's own (routes-books.ts), so it goes when its book does.
const translationBodies = new WeakMap<Chapter, Map<LangCode, JsonBody>>();

/** `text`, the chapter's translation in `lang`, with the tag and gzip already made for the same text. */
function translationBody(chapter: Chapter, lang: LangCode, text: string): JsonBody {
  let byLang = translationBodies.get(chapter);
  if (!byLang) translationBodies.set(chapter, (byLang = new Map()));
  const known = byLang.get(lang);
  if (known?.text === text) return known;
  // New, or the translation has changed since (blocks translated that a service had missed): this one replaces it.
  const body = jsonBody(text);
  byLang.set(lang, body);
  return body;
}

/**
 * Where what DeepRead makes for a book is kept (its translations, its read-aloud clips): with the book, in its owner's own
 * library. A book shared with the reader is read from its owner's, so it is made once for the owner and everyone they
 * share it with.
 */
export function bookHome(c: Context<AppEnv>, accounts: Accounts | undefined, id: string): { library: Library; bookId: string } {
  const shared = parseSharedBookId(id);
  const ownerId = shared?.ownerId ?? c.var.session?.profile.id;
  // Without profiles there is the one library, which holds every book.
  if (!accounts || !ownerId) return { library: c.var.library, bookId: id };
  // The same library for every reader of the book, so two of them asking at once share one making of it.
  return { library: accounts.profiles.library(ownerId), bookId: shared?.bookId ?? id };
}

/** A chapter about to be translated, with the book it is in and where its notes are kept: what the book's notes are made from. */
type Notable = { styles: StyleKeeper; library: Library; bookId: string; lang: LangCode; book: ParsedBook; chapter: Chapter };

/**
 * The AI helper that would translate for whoever is asking, or undefined when they have none (or the admin chose the free
 * services alone, which need none). It is their helper and nobody else's: with profiles it is the one the admin gave them,
 * and when it is the API model each request counts against their day, as every other use of it does.
 * With `notable`, it carries the book's translator's notes (translation-style.ts), so a name, a term and who says আপনি or
 * তুমি to whom are the same in a chapter as in an "In Bangla" answer. A book with no notes yet has them made first, which
 * takes a minute once; with notes, the names this chapter brings that they have not seen are added behind the translation.
 */
async function helpFor(c: Context<AppEnv>, llm: Ai | undefined, engine: TranslationSettings["engine"], book: Pick<ParsedBook, "title" | "author">, notable?: Notable): Promise<AiHelp | undefined> {
  if (!llm || (engine !== "auto" && engine !== "ai")) return undefined;
  const { session } = c.var;
  // Without profiles the one reader may use anything that works, and the helper they picked answers.
  const access = session ? accessOf(session.profile) : ({ allowed: "all" } as const);
  if ((await llm.statusFor(access)).active === null) return undefined;
  const helper = session ? llm.for(access) : llm;
  const help: AiHelp = { llm: helper, who: session?.profile.id ?? "all", book: { title: book.title, author: book.author } };
  if (notable) {
    const { styles, library, bookId, lang, chapter } = notable;
    const request = { library, bookId, book: notable.book, lang, helper, chapter };
    if (await styles.style(library, bookId, lang)) void styles.ensure(request);
    else await styles.ensure(request);
    help.notes = async (passage) => {
      try {
        return styleNotes(await styles.style(library, bookId, lang), { text: passage });
      } catch {
        // The notes are an aid to the translation, never a reason to stop it.
        return "";
      }
    };
  }
  return help;
}

/** What every reader reaches: a chapter's translation, and whether they may have one. */
export function translationRoutes(deps: Translation & { accounts?: Accounts; llm?: Ai }): Hono<AppEnv> {
  const { settings, translator, accounts, llm, styles = bookStyles } = deps;
  const routes = new Hono<AppEnv>();

  routes.get("/translation", (c) => {
    const chosen = settings.get();
    return c.json({ ...chosen, enabled: mayTranslate(c, chosen) } satisfies TranslationSettings);
  });

  routes.get("/books/:id/chapters/:chapterId/translation", async (c) => {
    const id = c.req.param("id");
    const lang = c.req.query("lang");
    if (!isReadableBookId(id)) return invalidId(c);
    if (!isLangCode(lang)) return apiError(c, 400, "invalid_lang", LANG_HELP);
    const chosen = settings.get();
    if (!mayTranslate(c, chosen)) return apiError(c, 403, "translation_off", "The admin has turned translation off.");
    // Through the reader's shelf, like the chapter itself: a book that is not on it, or a share that has ended, is not found.
    const book = await c.var.library.book(id);
    if (!book) return bookNotFound(c);
    const chapter = book.chapters.find((candidate) => candidate.id === c.req.param("chapterId"));
    if (!chapter) return chapterNotFound(c);
    try {
      const home = bookHome(c, accounts, id);
      const help = await helpFor(c, llm, chosen.engine, book, { styles, library: home.library, bookId: home.bookId, lang, book, chapter });
      const translation = await translator.chapter(home, chapter, lang, chosen.engine, help);
      // As big as the chapter: revalidating and gzipped, like it.
      return await sendJsonBody(c, translationBody(chapter, lang, JSON.stringify(translation)));
    } catch (error) {
      if (!(error instanceof TranslationError)) throw error;
      // Expected now and then: both services are unofficial, and an AI helper can be busy or over its limit. The reader is
      // told what they can act on, else to try again; the log says why.
      console.warn(`chapter translation failed: ${error.message}`);
      return apiError(c, 502, "translation_unavailable", error.readerMessage ?? "The translation services could not be reached just now.");
    }
  });

  return routes;
}

/**
 * The admin's side: whether readers may have chapters translated, which service translates, and a try of it. Only with
 * profiles on, where there is an admin; only the admin reaches these, also while viewing as someone else.
 */
export function translationAdminRoutes(deps: Translation & { llm?: Ai }): Hono<AppEnv> {
  const { settings, translator, llm } = deps;
  const routes = new Hono<AppEnv>();
  const jsonLimit = bodyLimit({ maxSize: 4 * 1024, onError: (c) => invalidBody(c, "the body is too large.") });

  routes.use("*", async (c, next) => (c.var.session?.actor.admin ? next() : adminOnly(c)));

  routes.get("/", (c) => c.json(settings.get()));

  routes.put("/", jsonLimit, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, SETTINGS_HELP);
    const patch: Partial<TranslationSettings> = {};
    if (Object.hasOwn(body, "enabled")) {
      if (typeof body.enabled !== "boolean") {
        return apiError(c, 400, "invalid_enabled", "enabled is true or false: whether readers may have a chapter translated.");
      }
      patch.enabled = body.enabled;
    }
    if (Object.hasOwn(body, "engine")) {
      if (!isTranslationEngine(body.engine)) {
        return apiError(c, 400, "invalid_engine", `That is not a translation service DeepRead knows. Pick one of: ${TRANSLATION_ENGINES.join(", ")}.`);
      }
      patch.engine = body.engine;
    }
    if (Object.keys(patch).length === 0) return invalidBody(c, SETTINGS_HELP);
    return c.json(await settings.save(patch));
  });

  // One sentence with the chosen engine: the admin sees at once whether it answers from this computer, and how it reads.
  routes.post("/test", jsonLimit, async (c) => {
    const lang = (await readJsonObject(c))?.lang;
    if (!isLangCode(lang)) return apiError(c, 400, "invalid_lang", LANG_HELP);
    const { engine } = settings.get();
    return c.json(await translator.test(lang, engine, await helpFor(c, llm, engine, { title: "A sample sentence", author: null })));
  });

  return routes;
}
