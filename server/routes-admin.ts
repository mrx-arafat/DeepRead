// The admin's dashboard: adding, changing and removing profiles and their photos, and viewing DeepRead as someone else.
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AVATAR_PRESETS } from "../shared/types.ts";
import type { AdminProfile, NewProfile, ProfileUpdate, Session } from "../shared/types.ts";
import type { AppEnv } from "./app-env.ts";
import { isPhotoFile, MAX_PHOTO_BYTES, squarePhoto } from "./avatar.ts";
import type { Accounts } from "./deps.ts";
import { adminOnly, apiError, invalidBody, readJsonObject } from "./http.ts";
import { isAvatarPreset, isProfileId, MAX_BADGE_CHARS, MAX_CODE_CHARS, MAX_NAME_CHARS, MIN_CODE_CHARS, ProfileError } from "./profiles.ts";
import type { StoredProfile } from "./profiles.ts";
import { profileNotFound } from "./routes-session.ts";
import { startSession, toSession } from "./sessions.ts";
import type { SignedIn } from "./sessions.ts";

// Multipart framing adds a little to the file itself; the exact file size is checked after parsing.
const MULTIPART_SLACK_BYTES = 64 * 1024;
const PROFILE_HELP = 'send JSON like {"name": "Mina", "code": "246810", "preset": "smile-blue"}.';

const tooLarge = (c: Context): Response => apiError(c, 413, "too_large", "That picture is larger than 5 MB. Choose a smaller one.");
const notPhoto = (c: Context): Response =>
  apiError(c, 415, "not_image", "That file is not a picture DeepRead can use. Choose a PNG, JPEG or WebP.");

/** Checks the fields of a new profile (`whole`: all three) or of a change to one; the Response is the 400 to send instead. */
function readProfileFields(c: Context, body: Record<string, unknown>, whole: boolean): ProfileUpdate | Response {
  const fields: ProfileUpdate = {};

  if (whole || Object.hasOwn(body, "name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "" || name.length > MAX_NAME_CHARS) {
      return apiError(c, 400, "invalid_name", `Give the profile a name of 1 to ${MAX_NAME_CHARS} characters.`);
    }
    fields.name = name;
  }

  if (whole || Object.hasOwn(body, "code")) {
    // Not trimmed: the code is exactly what was typed, and is typed the same way to sign in.
    const { code } = body;
    if (typeof code !== "string" || code.trim() === "" || code.length < MIN_CODE_CHARS || code.length > MAX_CODE_CHARS) {
      return apiError(c, 400, "invalid_code", `The code must be ${MIN_CODE_CHARS} to ${MAX_CODE_CHARS} characters long.`);
    }
    fields.code = code;
  }

  if (whole || Object.hasOwn(body, "preset")) {
    if (!isAvatarPreset(body.preset)) {
      return apiError(c, 400, "invalid_preset", `That picture is not one of DeepRead's. Pick one of: ${AVATAR_PRESETS.join(", ")}.`);
    }
    fields.preset = body.preset;
  }

  if (Object.hasOwn(body, "badge")) {
    const badge = typeof body.badge === "string" ? body.badge.trim() : null;
    if (badge === null || badge.length > MAX_BADGE_CHARS) {
      return apiError(c, 400, "invalid_badge", `A badge is up to ${MAX_BADGE_CHARS} characters. Leave it empty for none.`);
    }
    fields.badge = badge;
  }

  if (Object.keys(fields).length === 0) {
    return apiError(c, 400, "invalid_request", "Nothing to change. Send a new name, code, picture or badge.");
  }
  return fields;
}

/** The admin's routes. Every one needs the admin signed in, also while they view DeepRead as someone else. */
export function adminRoutes(accounts: Accounts): Hono<AppEnv> {
  const { profiles, sessionKey } = accounts;
  const routes = new Hono<AppEnv>();
  const jsonLimit = bodyLimit({ maxSize: 16 * 1024, onError: (c) => invalidBody(c, "the body is too large.") });

  routes.use("*", async (c, next) => (c.var.session?.actor.admin ? next() : adminOnly(c)));

  async function shown(profile: StoredProfile): Promise<AdminProfile> {
    const [view] = await profiles.describe([profile]);
    if (!view) throw new Error(`no dashboard view for profile ${profile.id}`);
    return view;
  }

  /** Runs `work`, answering a change the rules refuse (a taken name, the admin's code) with its 400. */
  async function withinRules(c: Context, work: () => Promise<Response>): Promise<Response> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProfileError) return apiError(c, 400, error.code, error.message);
      throw error;
    }
  }

  routes.get("/profiles", async (c) => c.json(await profiles.describe(await profiles.list())));

  routes.post("/profiles", jsonLimit, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, PROFILE_HELP);
    const fields = readProfileFields(c, body, true);
    if (fields instanceof Response) return fields;
    // Read whole: name, code and preset were all checked.
    const made = fields as NewProfile;
    return withinRules(c, async () => c.json(await shown(await profiles.create(made)), 201));
  });

  routes.patch("/profiles/:id", jsonLimit, async (c) => {
    const id = c.req.param("id");
    if (!isProfileId(id)) return profileNotFound(c);
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, PROFILE_HELP);
    const fields = readProfileFields(c, body, false);
    if (fields instanceof Response) return fields;
    return withinRules(c, async () => {
      const updated = await profiles.update(id, fields);
      return updated ? c.json(await shown(updated)) : profileNotFound(c);
    });
  });

  routes.put(
    "/profiles/:id/photo",
    bodyLimit({ maxSize: MAX_PHOTO_BYTES + MULTIPART_SLACK_BYTES, onError: tooLarge }),
    async (c) => {
      const id = c.req.param("id");
      if (!isProfileId(id) || !(await profiles.find(id))) return profileNotFound(c);
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        return apiError(c, 400, "invalid_upload", "The upload could not be read. Choose the picture again and retry.");
      }
      const file = form["file"];
      if (!(file instanceof File)) {
        return apiError(c, 400, "missing_file", "No picture was attached. Choose a PNG, JPEG or WebP and try again.");
      }
      if (file.size > MAX_PHOTO_BYTES) return tooLarge(c);
      // The name and declared type come from the browser; only the bytes say what the file is.
      const data = new Uint8Array(await file.arrayBuffer());
      if (!isPhotoFile(data)) return notPhoto(c);
      const photo = await squarePhoto(data);
      if (photo === "unreadable") return notPhoto(c);
      if (photo === "too_large") return apiError(c, 413, "too_large", "That picture has too many pixels to use. Choose a smaller one.");
      const updated = await profiles.setPhoto(id, photo);
      return updated ? c.json(await shown(updated)) : profileNotFound(c);
    },
  );

  routes.delete("/profiles/:id/photo", async (c) => {
    const id = c.req.param("id");
    const updated = isProfileId(id) ? await profiles.removePhoto(id) : null;
    return updated ? c.json(await shown(updated)) : profileNotFound(c);
  });

  routes.delete("/profiles/:id", async (c) => {
    const id = c.req.param("id");
    if (!isProfileId(id)) return profileNotFound(c);
    return withinRules(c, async () => {
      if (!(await profiles.remove(id))) return profileNotFound(c);
      const session = c.var.session;
      // The admin was viewing as this profile: they are back as themselves rather than signed out.
      if (session && session.profile.id === id) startSession(c, sessionKey, { ...session, profile: session.actor });
      return c.body(null, 204);
    });
  });

  // Ends every session of the profile at once, such as one on a lost phone; the code is unchanged.
  routes.post("/profiles/:id/sign-out", async (c) => {
    const id = c.req.param("id");
    if (!isProfileId(id)) return profileNotFound(c);
    return withinRules(c, async () => ((await profiles.signOut(id)) ? c.body(null, 204) : profileNotFound(c)));
  });

  routes.post("/impersonate/:id", async (c) => {
    const session = c.var.session;
    if (!session) return adminOnly(c);
    const id = c.req.param("id");
    const target = isProfileId(id) ? await profiles.find(id) : null;
    if (!target) return profileNotFound(c);
    // Ends when the admin's own sign-in does: viewing as someone never lengthens a session.
    const viewing: SignedIn = { profile: target, actor: session.actor, expiresAt: session.expiresAt };
    startSession(c, sessionKey, viewing);
    return c.json(toSession(viewing) satisfies Session);
  });

  routes.delete("/impersonate", (c) => {
    const session = c.var.session;
    if (!session) return adminOnly(c);
    const own: SignedIn = { ...session, profile: session.actor };
    startSession(c, sessionKey, own);
    return c.json(toSession(own) satisfies Session);
  });

  return routes;
}
