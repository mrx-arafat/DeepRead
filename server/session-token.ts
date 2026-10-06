// What the deepread_session cookie holds: who signed in, until when, signed so it cannot be forged or edited.
// Nothing is kept on the server per session. A session ends when it expires, or when the profile behind it changes
// its code (its sessionVersion moves on) or is removed.
import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionClaims = {
  /** Whose books this browser reads. */
  profileId: string;
  /** Who signed in: the admin while viewing as someone else, otherwise `profileId`. */
  actorId: string;
  /** The actor's sessionVersion when they signed in. */
  version: number;
  /** Milliseconds since 1970. */
  expiresAt: number;
};

type Versioned = { id: string; admin: boolean; sessionVersion: number };

function sign(payload: string, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** base64url(JSON) "." base64url(HMAC-SHA256 of the first part). */
export function signToken(claims: SessionClaims, key: Uint8Array): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, key).toString("base64url")}`;
}

function isClaims(value: unknown): value is SessionClaims {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.profileId === "string" &&
    typeof claims.actorId === "string" &&
    Number.isInteger(claims.version) &&
    Number.isFinite(claims.expiresAt)
  );
}

/** The claims of a token this key signed and that has not expired by `now`; null for anything else. */
export function readToken(token: string, key: Uint8Array, now: number): SessionClaims | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = sign(payload, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return isClaims(claims) && claims.expiresAt > now ? claims : null;
}

/**
 * The profiles a token's claims name, while they still stand: both profiles exist, the actor has not changed their code
 * since, and only the admin views as someone else. Null when the session has ended.
 */
export function resolveClaims<P extends Versioned>(
  claims: SessionClaims,
  find: (id: string) => P | undefined,
): { profile: P; actor: P } | null {
  const actor = find(claims.actorId);
  const profile = find(claims.profileId);
  if (!actor || !profile || actor.sessionVersion !== claims.version) return null;
  if (profile.id !== actor.id && !actor.admin) return null;
  return { profile, actor };
}

/**
 * The key that signs sessions: the secret kept on this computer, bound to ADMIN_PASSKEY. A new passkey signs everyone
 * out, so changing a passkey that leaked also ends whatever was opened with it.
 */
export function sessionKey(secret: Uint8Array, adminPasskey: string): Buffer {
  return createHmac("sha256", secret).update(adminPasskey.normalize("NFC")).digest();
}
