import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { join } from "node:path";
import type { QuickTranslation } from "../shared/types.ts";
import type { AppEnv } from "./app-env.ts";
import type { AppDeps } from "./deps.ts";
import { apiError, invalidBody, isLangCode, LANG_HELP, signInRequired } from "./http.ts";
import { LibraryClosedError } from "./library.ts";
import { accessGuard } from "./local-only.ts";
import { adminRoutes } from "./routes-admin.ts";
import { aiRoutes } from "./routes-ai.ts";
import { booksRoutes } from "./routes-books.ts";
import { openrouterRoutes } from "./routes-openrouter.ts";
import { sharesRoutes } from "./routes-shares.ts";
import { sessionRoutes } from "./routes-session.ts";
import { readerGuard } from "./sessions.ts";

const MAX_TRANSLATE_CHARS = 200;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("/api/*", accessGuard(deps.remoteKey));
  app.get("/api/health", (c) => c.json({ ok: true }));
  // Before the guard below: the profile picker shows these to people who have not signed in yet.
  app.route("/api", sessionRoutes(deps.accounts));

  // Every route after this reads c.var.library, the books of whoever is signed in; with profiles, nobody gets no further.
  app.use("/api/*", readerGuard(deps));
  if (deps.accounts) app.route("/api/admin", adminRoutes(deps.accounts));
  // The admin's OpenRouter key and model: only with profiles on, where there is an admin to hold them (with one library, .env does it).
  if (deps.accounts && deps.openrouter) app.route("/api/admin/openrouter", openrouterRoutes({ openrouter: deps.openrouter, llm: deps.llm }));
  app.get("/api/storage", async (c) => c.json(await c.var.library.usage()));

  app.get("/api/translate", async (c) => {
    const text = (c.req.query("q") ?? "").trim();
    const lang = c.req.query("lang");
    if (text === "") return invalidBody(c, "q (the text to translate) is required.");
    if (text.length > MAX_TRANSLATE_CHARS) {
      return apiError(c, 400, "too_long", `Quick translation works on up to ${MAX_TRANSLATE_CHARS} characters. Select less text.`);
    }
    if (!isLangCode(lang)) return apiError(c, 400, "invalid_lang", LANG_HELP);
    try {
      const translation = await deps.quickTranslate(text, lang);
      return c.json({ text, translation, lang } satisfies QuickTranslation);
    } catch (error) {
      // Expected now and then (the endpoint is unofficial); the UI falls back to the AI word explanation.
      console.warn("quick translate failed:", error instanceof Error ? error.message : error);
      return apiError(c, 502, "translate_unavailable", "Quick translation is not available right now.");
    }
  });

  // Sharing is between profiles, so without them these addresses are unknown like any other.
  if (deps.accounts) app.route("/api", sharesRoutes(deps.accounts));
  app.route("/api/books", booksRoutes({ parsePdf: deps.parsePdf, renderCover: deps.renderCover }));
  app.route("/api/ai", aiRoutes({ llm: deps.llm, accounts: deps.accounts }));

  // Unknown API paths answer in JSON, never with the web app's HTML.
  app.all("/api/*", (c) => apiError(c, 404, "not_found", "There is nothing at this address."));

  if (deps.webRoot) {
    const indexPath = join(deps.webRoot, "index.html");
    app.use("/*", serveStatic({ root: deps.webRoot }));
    // Client-side routes fall back to the app shell; a missing file (/assets/x.js) must stay a real 404.
    app.get("*", (c, next) => (/\.[a-z0-9]+$/i.test(c.req.path) ? next() : serveStatic({ path: indexPath })(c, next)));
  }

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    // The profile was removed while this request was under way (profiles.ts closed its library): there is no one to
    // read as any more, which is what the reader is told for any other request from a removed profile.
    if (error instanceof LibraryClosedError) return signInRequired(c);
    console.error("unhandled error:", error);
    return apiError(c, 500, "internal", "Something went wrong on our side. Please try again.");
  });
  app.notFound((c) => apiError(c, 404, "not_found", "There is nothing at this address."));

  return app;
}
