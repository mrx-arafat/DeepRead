import { describe, expect, it } from "vitest";
import { readToken, resolveClaims, sessionKey, signToken } from "./session-token.ts";
import type { SessionClaims } from "./session-token.ts";

const KEY = sessionKey(Buffer.alloc(32, 7), "a long admin passkey");
const NOW = Date.parse("2026-10-06T12:00:00Z");
const claims: SessionClaims = { profileId: "mina-a1b2c3", actorId: "mina-a1b2c3", version: 2, expiresAt: NOW + 60_000 };

const profiles = [
  { id: "admin-000000", admin: true, sessionVersion: 1 },
  { id: "mina-a1b2c3", admin: false, sessionVersion: 2 },
  { id: "rafi-d4e5f6", admin: false, sessionVersion: 1 },
];
const find = (id: string) => profiles.find((profile) => profile.id === id);

describe("session tokens", () => {
  it("should read back the claims it signed when the token is untouched and unexpired", () => {
    const token = signToken(claims, KEY);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(readToken(token, KEY, NOW)).toEqual(claims);
  });

  it("should refuse a token when it was tampered with or signed with another key", () => {
    const token = signToken(claims, KEY);
    const [payload, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...claims, profileId: "rafi-d4e5f6" })).toString("base64url");

    expect(readToken(`${forged}.${signature}`, KEY, NOW)).toBeNull();
    expect(readToken(`${payload}.${signature.slice(0, -2)}`, KEY, NOW)).toBeNull();
    expect(readToken(`${payload}.${signature}.extra`, KEY, NOW)).toBeNull();
    expect(readToken(payload, KEY, NOW)).toBeNull();
    // A new ADMIN_PASSKEY means a new key: every session made with the old one ends.
    expect(readToken(token, sessionKey(Buffer.alloc(32, 7), "the new passkey"), NOW)).toBeNull();
    // Signed, but not claims: still refused.
    const notClaims = Buffer.from(JSON.stringify({ profileId: "mina-a1b2c3" })).toString("base64url");
    expect(readToken(`${notClaims}.${signToken(claims, KEY).split(".")[1]}`, KEY, NOW)).toBeNull();
  });

  it("should refuse a token when it has expired", () => {
    const token = signToken(claims, KEY);
    expect(readToken(token, KEY, claims.expiresAt - 1)).toEqual(claims);
    expect(readToken(token, KEY, claims.expiresAt)).toBeNull();
  });

  it("should end a session when the actor's code changed, a profile is gone, or a non-admin views as someone else", () => {
    expect(resolveClaims(claims, find)).toEqual({ profile: profiles[1], actor: profiles[1] });
    expect(resolveClaims({ ...claims, version: 1 }, find)).toBeNull();
    expect(resolveClaims({ ...claims, profileId: "gone-999999", actorId: "gone-999999" }, find)).toBeNull();

    const viewing = { profileId: "mina-a1b2c3", actorId: "admin-000000", version: 1, expiresAt: claims.expiresAt };
    // The admin's own version counts, not that of the profile they view as.
    expect(resolveClaims(viewing, find)).toEqual({ profile: profiles[1], actor: profiles[0] });
    expect(resolveClaims({ ...viewing, profileId: "gone-999999" }, find)).toBeNull();
    expect(resolveClaims({ ...viewing, actorId: "rafi-d4e5f6" }, find)).toBeNull();
  });
});
