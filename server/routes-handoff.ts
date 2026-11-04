// Open in ChatGPT over HTTP: whether this reader gets the button, and the admin's switch for every reader.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HandoffSettings } from "../shared/types.ts";
import type { AppEnv } from "./app-env.ts";
import type { HandoffSettingsStore } from "./handoff-settings.ts";
import { adminOnly, apiError, invalidBody, readJsonObject } from "./http.ts";

const SETTINGS_HELP = 'send JSON like {"enabled": true}.';

/**
 * What every reader reaches: whether they get the button. The admin always does, also while viewing as someone else,
 * and without profiles there is nobody to turn it off for.
 */
export function handoffRoutes(settings: HandoffSettingsStore): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get("/handoff", (c) => {
    const { session } = c.var;
    return c.json({ enabled: session === null || settings.get().enabled || session.actor.admin } satisfies HandoffSettings);
  });
  return routes;
}

/** The admin's side: only with profiles on, where there is an admin; only the admin reaches these, also while viewing as someone else. */
export function handoffAdminRoutes(settings: HandoffSettingsStore): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("*", async (c, next) => (c.var.session?.actor.admin ? next() : adminOnly(c)));
  routes.get("/", (c) => c.json(settings.get()));
  routes.put("/", bodyLimit({ maxSize: 1024, onError: (c) => invalidBody(c, "the body is too large.") }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, SETTINGS_HELP);
    if (typeof body.enabled !== "boolean") {
      return apiError(c, 400, "invalid_enabled", "enabled is true or false: whether readers get the button that opens a deep dive in an outside chat.");
    }
    return c.json(await settings.save({ enabled: body.enabled }));
  });
  return routes;
}
