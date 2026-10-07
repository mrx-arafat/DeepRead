import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { apiError } from "./http.ts";
import { STRONG_PASSKEY_CHARS } from "./profiles.ts";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const KEY_COOKIE = "deepread_key";
const UNLOCK_PATH = "/api/unlock";
const UNLOCK_DAYS = 30;

/** `host` is "name" or "name:port", as in a Host header or a URL's host. */
function isLoopback(host: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    // "null" (sandboxed frames, file://) and garbage both land here and are refused.
    return "";
  }
}

function sameSecret(given: string | undefined, key: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Opening `/api/unlock?key=...` on a phone stores the key in a cookie, then shows the library. */
function unlock(c: Context, key: string): Response {
  if (!sameSecret(c.req.query("key"), key)) {
    return apiError(c, 403, "locked", "That link has the wrong key. Use the link shown where DeepRead was started.");
  }
  setCookie(c, KEY_COOKIE, key, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: UNLOCK_DAYS * 24 * 60 * 60,
  });
  return c.redirect("/", 302);
}

/**
 * True when the request did not start on this computer. The Host header cannot tell: both cloudflared
 * and the Vite dev proxy rewrite it to a loopback address. Cloudflare's edge always adds cf-connecting-ip
 * and cf-ray, and a remote client cannot remove them, so their presence marks tunnel traffic.
 */
function isRemote(c: Context): boolean {
  if (c.req.header("cf-connecting-ip") !== undefined || c.req.header("cf-ray") !== undefined) return true;
  return !isLoopback(new URL(c.req.url).host);
}

/** Other websites' pages may not use the API from a visitor's browser; opening an address directly sends `none`. */
function fromOtherSite(c: Context): boolean {
  const fetchSite = c.req.header("sec-fetch-site");
  return fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none";
}

const PUBLIC_URL_HELP = "Set DEEPREAD_PUBLIC_URL to the address people type, such as https://read.example.com, with nothing after the name.";

/**
 * The origin DeepRead is published at (DEEPREAD_PUBLIC_URL), or undefined when it is not published.
 * There anyone can reach the profile picker, so it insists on profiles with a strong ADMIN_PASSKEY, and on https,
 * which the sign-in cookie needs. Throws with the setting to fix.
 */
export function publicOriginFrom(value: string | undefined, adminPasskey: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`DEEPREAD_PUBLIC_URL is not a web address. ${PUBLIC_URL_HELP}`);
  }
  if (url.protocol !== "https:") throw new Error(`DEEPREAD_PUBLIC_URL must start with https://, which signing in needs. ${PUBLIC_URL_HELP}`);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`DEEPREAD_PUBLIC_URL must be the site's own address: DeepRead cannot be served from a folder of a site. ${PUBLIC_URL_HELP}`);
  }
  if (!adminPasskey) {
    throw new Error("DEEPREAD_PUBLIC_URL lets anyone reach DeepRead, so it needs profiles: set ADMIN_PASSKEY too.");
  }
  if (adminPasskey.length < STRONG_PASSKEY_CHARS) {
    throw new Error(
      `DEEPREAD_PUBLIC_URL lets anyone try codes, so ADMIN_PASSKEY, which opens every profile, must be at least ${STRONG_PASSKEY_CHARS} characters long.`,
    );
  }
  return url.origin;
}

/**
 * Without profiles the API has no login, and with them a profile's code is all that guards its books, so by default
 * only the reader's own browser tab may use it at all. This runs before any sign-in is looked at.
 * - Host check: stops DNS rebinding, where a hostile site points its own name at 127.0.0.1.
 * - Origin check: stops other websites from posting uploads or model requests (which spend the
 *   reader's Claude usage) from the reader's browser; browsers always send Origin on those requests.
 * Tools like curl send no Origin and are unaffected.
 *
 * With `remoteKey` set (for reading on a phone through a tunnel), a remote device is let in once it has
 * opened the unlock link with that key, which stores it in an HttpOnly, SameSite=Strict, host-only cookie.
 * Its requests must also be same-origin (Sec-Fetch-Site), so other websites cannot borrow the device.
 *
 * With `publicOrigin` set (published on a server, see publicOriginFrom), requests for that host name are let in with
 * no key: each profile's code guards its books there. The Origin and Sec-Fetch-Site checks still keep other websites out.
 */
export function accessGuard(remoteKey?: string, publicOrigin?: string): MiddlewareHandler {
  const publicHost = publicOrigin === undefined ? undefined : new URL(publicOrigin).host;
  return async (c, next) => {
    if (publicHost !== undefined && new URL(c.req.url).host === publicHost) {
      const origin = c.req.header("origin");
      if ((origin !== undefined && origin !== publicOrigin) || fromOtherSite(c)) {
        return apiError(c, 403, "forbidden_origin", "DeepRead only answers requests from its own pages.");
      }
      return next();
    }

    if (!isRemote(c)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !isLoopback(hostOfOrigin(origin))) {
        return apiError(c, 403, "forbidden_origin", "DeepRead only answers requests from this computer.");
      }
      return next();
    }

    if (!remoteKey) {
      return apiError(c, 403, "forbidden_origin", "DeepRead only answers requests from this computer.");
    }
    if (c.req.path === UNLOCK_PATH) return unlock(c, remoteKey);
    if (fromOtherSite(c)) {
      return apiError(c, 403, "forbidden_origin", "DeepRead only answers requests from its own pages.");
    }
    if (!sameSecret(getCookie(c, KEY_COOKIE), remoteKey)) {
      return apiError(c, 403, "locked", "Open the DeepRead link with the key on this device first.");
    }
    return next();
  };
}
