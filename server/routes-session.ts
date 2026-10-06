// What anyone may ask before signing in: whether there are profiles, who they are, and signing in or out.
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PublicProfile, Session, SessionInfo } from "../shared/types.ts";
import type { AppEnv } from "./app-env.ts";
import type { Accounts } from "./deps.ts";
import { apiError, invalidBody, readJsonObject, readString } from "./http.ts";
import { isProfileId, MAX_PASSKEY_CHARS, publicProfile } from "./profiles.ts";
import { currentSession, endSession, SESSION_MS, startSession, toSession } from "./sessions.ts";

const MAX_ID_FIELD = 200;

export const profileNotFound = (c: Context): Response =>
  apiError(c, 404, "profile_not_found", "That profile is not here. It may have been removed.");

/**
 * Who sent a code, so wrong codes lock out only them: the address Cloudflare saw for tunnel traffic (its edge sets
 * cf-connecting-ip, which a remote client cannot change; see local-only.ts), and this computer for everything else.
 */
const clientOf = (c: Context): string => c.req.header("cf-connecting-ip")?.trim() || "local";

/** `accounts` is absent without profiles: then there is nobody to sign in as, and nothing to sign in to. */
export function sessionRoutes(accounts: Accounts | undefined): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/session", async (c) => {
    if (!accounts) return c.json({ mode: "single" } satisfies SessionInfo);
    const session = await currentSession(c, accounts);
    return c.json({ mode: "profiles", session: session && toSession(session) } satisfies SessionInfo);
  });

  routes.get("/profiles", async (c) => {
    const profiles: PublicProfile[] = accounts ? (await accounts.profiles.list()).map(publicProfile) : [];
    return c.json(profiles);
  });

  routes.get("/profiles/:id/avatar", async (c) => {
    const id = c.req.param("id");
    const photo = accounts && isProfileId(id) ? await accounts.profiles.photo(id) : null;
    if (!photo) return apiError(c, 404, "photo_not_found", "This profile has no photo.");
    // The address carries ?v=<photo>, which changes with every upload, so a day's caching never shows an old face.
    return c.body(photo.data, 200, { "Content-Type": photo.type, "Cache-Control": "private, max-age=86400" });
  });

  routes.post(
    "/session",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => invalidBody(c, "the body is too large.") }),
    async (c) => {
      const body = await readJsonObject(c);
      const profileId = body && readString(body, "profileId", MAX_ID_FIELD);
      const code = body && readString(body, "code", MAX_PASSKEY_CHARS);
      if (!profileId || !code) return invalidBody(c, "send JSON like {\"profileId\": \"...\", \"code\": \"...\"}.");
      if (!accounts) return profileNotFound(c);

      const result = await accounts.profiles.signIn(profileId, code, clientOf(c));
      if (result.outcome === "not_found") return profileNotFound(c);
      if (result.outcome === "wrong_code") return apiError(c, 401, "wrong_code", "That code is not right.");
      if (result.outcome === "locked") {
        const minutes = `${result.minutes} minute${result.minutes === 1 ? "" : "s"}`;
        return apiError(c, 429, "too_many_tries", `Too many wrong codes. Try again in ${minutes}.`);
      }
      const session = { profile: result.profile, actor: result.profile, expiresAt: Date.now() + SESSION_MS };
      startSession(c, accounts.sessionKey, session);
      return c.json(toSession(session) satisfies Session);
    },
  );

  routes.delete("/session", (c) => {
    endSession(c);
    return c.body(null, 204);
  });

  return routes;
}
