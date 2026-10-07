// Chapter translation over HTTP: a chapter in the reader's language, whether this reader may have one, and the admin's
// side: whether readers may, which service translates, and a try of that service on one sentence.
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TRANSLATION_ENGINES } from "../shared/types.ts";
import type { TranslationSettings } from "../shared/types.ts";
import type { AppEnv } from "./app-env.ts";
import { isTranslationEngine, TranslationError } from "./chapter-translation.ts";
import type { Translation, TranslationHome } from "./chapter-translation.ts";
import type { Accounts } from "./deps.ts";
import { adminOnly, apiError, bookNotFound, chapterNotFound, invalidBody, invalidId, isLangCode, LANG_HELP, readJsonObject } from "./http.ts";
import { isReadableBookId, parseSharedBookId } from "./shares.ts";

const SETTINGS_HELP = 'send JSON like {"enabled": true, "engine": "auto"}.';

/**
 * Whether this reader may have a chapter translated: unless the admin turned it off for readers. The admin always may, also
 * while viewing as someone else, and without profiles there is nobody to turn it off for.
 */
function mayTranslate(c: Context<AppEnv>, settings: TranslationSettings): boolean {
  const { session } = c.var;
  return session === null || settings.enabled || session.actor.admin;
}

/** What every reader reaches: a chapter's translation, and whether they may have one. */
export function translationRoutes(deps: Translation & { accounts?: Accounts }): Hono<AppEnv> {
  const { settings, translator, accounts } = deps;
  const routes = new Hono<AppEnv>();

  /**
   * Where a book's translations are kept: with the book, in its owner's own library. A book shared with the reader is read
   * from its owner's, so its translation is made once for the owner and everyone they share it with.
   */
  function homeOf(c: Context<AppEnv>, id: string): TranslationHome {
    const shared = parseSharedBookId(id);
    const ownerId = shared?.ownerId ?? c.var.session?.profile.id;
    // Without profiles there is the one library, which holds every book.
    if (!accounts || !ownerId) return { library: c.var.library, bookId: id };
    // The same library for every reader of the book, so two of them opening a chapter at once share one translation.
    return { library: accounts.profiles.library(ownerId), bookId: shared?.bookId ?? id };
  }

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
      return c.json(await translator.chapter(homeOf(c, id), chapter, lang, chosen.engine));
    } catch (error) {
      if (!(error instanceof TranslationError)) throw error;
      // Expected now and then: both services are unofficial. The reader is told to try again; the log says why.
      console.warn(`chapter translation failed: ${error.message}`);
      return apiError(c, 502, "translation_unavailable", "The translation services could not be reached just now.");
    }
  });

  return routes;
}

/**
 * The admin's side: whether readers may have chapters translated, which service translates, and a try of it. Only with
 * profiles on, where there is an admin; only the admin reaches these, also while viewing as someone else.
 */
export function translationAdminRoutes(deps: Translation): Hono<AppEnv> {
  const { settings, translator } = deps;
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

  // One sentence with the chosen service: the admin sees at once whether it answers from this computer, and how it reads.
  routes.post("/test", jsonLimit, async (c) => {
    const lang = (await readJsonObject(c))?.lang;
    if (!isLangCode(lang)) return apiError(c, 400, "invalid_lang", LANG_HELP);
    return c.json(await translator.test(lang, settings.get().engine));
  });

  return routes;
}
