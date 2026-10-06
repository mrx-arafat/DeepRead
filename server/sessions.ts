// The deepread_session cookie: read on every request, set when someone signs in, and the guard that settles whose
// books a request reads.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Session } from "../shared/types.ts";
import type { AppEnv } from "./app-env.ts";
import type { Accounts, AppDeps } from "./deps.ts";
import { signInRequired } from "./http.ts";
import { publicProfile } from "./profiles.ts";
import type { StoredProfile } from "./profiles.ts";
import { readToken, resolveClaims, signToken } from "./session-token.ts";

const COOKIE = "deepread_session";
const SECRET_BYTES = 32;
/** How long signing in lasts: fixed from that moment, not renewed by use. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** A session that still stands: whose books are read, who signed in (the admin, while viewing as `profile`), and until when. */
export type SignedIn = { profile: StoredProfile; actor: StoredProfile; expiresAt: number };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * The random bytes that sign sessions, kept in <dataDir>/session-secret and never in the store, so a copy of the bucket
 * cannot make sessions. Made on first use; a damaged one is replaced, which only signs everyone out.
 */
export async function loadSessionSecret(dataDir: string): Promise<Buffer> {
  const path = join(dataDir, "session-secret");
  const existing = await readFile(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (existing?.length === SECRET_BYTES) return existing;
  const secret = randomBytes(SECRET_BYTES);
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, secret, { mode: 0o600 });
  // The mode above applies only to a file being created; a damaged one being replaced keeps its own.
  await chmod(path, 0o600);
  return secret;
}

/** Through the tunnel (Cloudflare adds cf-ray and cf-connecting-ip) or behind a proxy that says so, the browser is on https. */
function overHttps(c: Context): boolean {
  return (
    new URL(c.req.url).protocol === "https:" ||
    c.req.header("x-forwarded-proto") === "https" ||
    c.req.header("cf-ray") !== undefined ||
    c.req.header("cf-connecting-ip") !== undefined
  );
}

/** The session in this request's cookie, or null when there is none or it has ended. */
export async function currentSession(c: Context, accounts: Accounts): Promise<SignedIn | null> {
  const token = getCookie(c, COOKIE);
  const claims = token ? readToken(token, accounts.sessionKey, Date.now()) : null;
  if (!claims) return null;
  const profiles = await accounts.profiles.list();
  const found = resolveClaims(claims, (id) => profiles.find((profile) => profile.id === id));
  return found && { ...found, expiresAt: claims.expiresAt };
}

/** Sets the cookie for `session`, lasting until its `expiresAt`. */
export function startSession(c: Context, key: Uint8Array, session: SignedIn): void {
  const { profile, actor, expiresAt } = session;
  const token = signToken({ profileId: profile.id, actorId: actor.id, version: actor.sessionVersion, expiresAt }, key);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: overHttps(c),
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  });
}

export function endSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", secure: overHttps(c) });
}

export function toSession({ profile, actor, expiresAt }: SignedIn): Session {
  return {
    profile: publicProfile(profile),
    admin: actor.admin,
    impersonatedBy: actor.id === profile.id ? null : publicProfile(actor),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Settles whose books a request reads. Without profiles, the one library. With them, the signed-in profile's (the viewed
 * one's while the admin views as someone), and a request from nobody is refused before any route runs.
 */
export function readerGuard(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!deps.accounts) {
      c.set("library", deps.library);
      c.set("session", null);
      return next();
    }
    const session = await currentSession(c, deps.accounts);
    if (!session) return signInRequired(c);
    c.set("session", session);
    c.set("library", deps.accounts.profiles.library(session.profile.id));
    return next();
  };
}
