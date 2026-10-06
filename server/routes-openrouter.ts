import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { OpenRouterAdminView, OpenRouterPatch } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import type { AppEnv } from "./app-env.ts";
import { adminOnly, apiError, invalidBody, readJsonObject } from "./http.ts";
import { OpenRouterError } from "./openrouter.ts";
import type { OpenRouter } from "./openrouter.ts";

const NOTHING_TO_CHANGE = 'send JSON like {"apiKey": "sk-or-...", "model": "vendor/model-name", "dailyLimit": 100}; null takes away what was saved.';

/**
 * The admin's side of OpenRouter: the key and the model that answer for every reader, and the means to try them. Only the
 * admin reaches these, also while viewing as someone else, and the key is only ever received here, never sent back.
 */
export function openrouterRoutes(deps: { openrouter: OpenRouter; llm: Ai }): Hono<AppEnv> {
  const { openrouter, llm } = deps;
  const routes = new Hono<AppEnv>();
  const jsonLimit = bodyLimit({ maxSize: 4 * 1024, onError: (c) => invalidBody(c, "the body is too large.") });

  routes.use("*", async (c, next) => (c.var.session?.actor.admin ? next() : adminOnly(c)));

  async function view(): Promise<OpenRouterAdminView> {
    return { ...(await openrouter.describe()), active: (await llm.status()).active };
  }

  routes.get("/", async (c) => c.json(await view()));

  routes.put("/", jsonLimit, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, NOTHING_TO_CHANGE);
    const patch: OpenRouterPatch = {};
    for (const field of ["apiKey", "model"] as const) {
      if (!Object.hasOwn(body, field)) continue;
      const value = body[field];
      if (value !== null && typeof value !== "string") return invalidBody(c, `${field} is text, or null to take away what was saved.`);
      patch[field] = value;
    }
    if (Object.hasOwn(body, "dailyLimit")) {
      const value = body.dailyLimit;
      if (value !== null && typeof value !== "number") return invalidBody(c, "dailyLimit is a number, or null to take away what was saved.");
      patch.dailyLimit = value;
    }
    if (Object.keys(patch).length === 0) return invalidBody(c, NOTHING_TO_CHANGE);
    try {
      await openrouter.save(patch);
    } catch (error) {
      if (error instanceof OpenRouterError) return apiError(c, 400, error.code, error.message);
      throw error;
    }
    return c.json(await view());
  });

  // Asks the model for one word: it costs a fraction of a cent, and tells the admin at once whether the key and model work.
  routes.post("/test", async (c) => c.json(await openrouter.test()));

  routes.get("/models", async (c) => {
    try {
      return c.json(await openrouter.models());
    } catch (error) {
      if (error instanceof OpenRouterError) return apiError(c, 502, error.code, error.message);
      throw error;
    }
  });

  return routes;
}
