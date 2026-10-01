import type { MiddlewareHandler } from "hono";
import { apiError } from "./http.ts";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

/**
 * The API has no login, so only the reader's own browser tab may use it.
 * - Host check: stops DNS rebinding, where a hostile site points its own name at 127.0.0.1.
 * - Origin check: stops other websites from posting uploads or model requests (which spend the
 *   reader's Claude usage) from the reader's browser; browsers always send Origin on those requests.
 * Tools like curl send no Origin and are unaffected.
 */
export const localOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  // c.req.url is built from the Host header by the server, so this is the Host the client asked for.
  const hostOk = isLoopback(new URL(c.req.url).host);
  const originOk = origin === undefined || isLoopback(hostOfOrigin(origin));
  if (!hostOk || !originOk) {
    return apiError(c, 403, "forbidden_origin", "DeepRead only answers requests from this computer.");
  }
  await next();
};
