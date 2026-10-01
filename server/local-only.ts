import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { apiError } from "./http.ts";

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

/**
 * The API has no login, so by default only the reader's own browser tab may use it.
 * - Host check: stops DNS rebinding, where a hostile site points its own name at 127.0.0.1.
 * - Origin check: stops other websites from posting uploads or model requests (which spend the
 *   reader's Claude usage) from the reader's browser; browsers always send Origin on those requests.
 * Tools like curl send no Origin and are unaffected.
 *
 * With `remoteKey` set (for reading on a phone through a tunnel), a remote device is let in once it has
 * opened the unlock link with that key, which stores it in an HttpOnly, SameSite=Strict, host-only cookie.
 * Its requests must also be same-origin (Sec-Fetch-Site), so other websites cannot borrow the device.
 */
export function accessGuard(remoteKey?: string): MiddlewareHandler {
  return async (c, next) => {
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
    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
      return apiError(c, 403, "forbidden_origin", "DeepRead only answers requests from its own pages.");
    }
    if (!sameSecret(getCookie(c, KEY_COOKIE), remoteKey)) {
      return apiError(c, 403, "locked", "Open the DeepRead link with the key on this device first.");
    }
    return next();
  };
}
