import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { join } from "node:path";
import type { QuickTranslation } from "../shared/types.ts";
import type { AppDeps } from "./deps.ts";
import { apiError, invalidBody, isLangCode, LANG_HELP } from "./http.ts";
import { accessGuard } from "./local-only.ts";
import { aiRoutes } from "./routes-ai.ts";
import { booksRoutes } from "./routes-books.ts";

const MAX_TRANSLATE_CHARS = 200;

export function createApp(deps: AppDeps): Hono {
  const { library } = deps;
  const app = new Hono();

  app.use("/api/*", accessGuard(deps.remoteKey));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/storage", async (c) => c.json(await library.usage()));

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

  app.route("/api/books", booksRoutes({ library, parsePdf: deps.parsePdf, renderCover: deps.renderCover }));
  app.route("/api/ai", aiRoutes({ library, llm: deps.llm }));

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
    console.error("unhandled error:", error);
    return apiError(c, 500, "internal", "Something went wrong on our side. Please try again.");
  });
  app.notFound((c) => apiError(c, 404, "not_found", "There is nothing at this address."));

  return app;
}
