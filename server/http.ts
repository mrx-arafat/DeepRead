import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { LANGUAGES } from "../shared/types.ts";
import type { ApiError, ExplainMode, LangCode } from "../shared/types.ts";

/** Every non-2xx answer goes through here so the client always gets the same `ApiError` shape. */
export function apiError(c: Context, status: ContentfulStatusCode, error: string, message: string): Response {
  const body: ApiError = { error, message };
  return c.json(body, status);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLangCode(value: unknown): value is LangCode {
  return typeof value === "string" && Object.hasOwn(LANGUAGES, value);
}

export const LANG_HELP = `Pick one of: ${Object.keys(LANGUAGES).join(", ")}.`;

// A Record type makes this list exhaustive: adding a mode to the contract fails to compile until handled here.
export const EXPLAIN_MODES: Record<ExplainMode, true> = { word: true, simple: true, example: true, native: true };

export function isExplainMode(value: unknown): value is ExplainMode {
  return typeof value === "string" && Object.hasOwn(EXPLAIN_MODES, value);
}

export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** The string at `key` if it is non-empty (after trimming) and within `maxLength`, otherwise null. */
export function readString(body: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) return null;
  return value;
}

export const invalidBody = (c: Context, detail: string): Response =>
  apiError(c, 400, "invalid_request", `The request was not understood: ${detail}`);

export const invalidId = (c: Context): Response =>
  apiError(c, 400, "invalid_id", "That book id is not valid.");

export const bookNotFound = (c: Context): Response =>
  apiError(c, 404, "book_not_found", "That book is not in your library. It may have been deleted.");

export const chapterNotFound = (c: Context): Response =>
  apiError(c, 404, "chapter_not_found", "That chapter was not found in this book.");

export const blockNotFound = (c: Context): Response =>
  apiError(c, 404, "block_not_found", "That paragraph was not found in this chapter.");

/** A book another profile shared with the reader: only its owner changes it, or passes it on. */
export const sharedReadOnly = (c: Context, owner: string | undefined): Response =>
  apiError(c, 403, "shared_read_only", `${owner ?? "Its owner"} shared this book with you, so only they can change or share it.`);

/** With profiles: nobody signed in, or the profile signed in as has been removed. */
export const signInRequired = (c: Context): Response =>
  apiError(c, 401, "sign_in_required", "Choose your profile to keep reading.");

/** With profiles: something only the admin may do, asked by someone else. */
export const adminOnly = (c: Context): Response => apiError(c, 403, "admin_only", "Only the admin can do that.");
