import { formatBytes } from "../../shared/bytes.ts";

/** What the server accepts as a profile photo: the same list and size, so the form never offers what would be refused. */
export const PHOTO_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const MAX_PHOTO_BYTES = 5_000_000;

/** "3 books", "1 book", "No books". */
export function bookCountText(count: number): string {
  if (count === 0) return "No books";
  return count === 1 ? "1 book" : `${count} books`;
}

/** "2 Oct 2026" in the admin's own language and time zone; empty when the date cannot be read. */
export function addedText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The question under a profile's row. It says what is lost, because a deleted profile cannot be brought back. */
export function deleteQuestion(name: string, bookCount: number): string {
  const lost =
    bookCount === 0
      ? "They have no books, so only the profile goes."
      : `Their ${bookCountText(bookCount).toLowerCase()}, notes and saved answers are removed for good.`;
  return `Delete ${name}? ${lost}`;
}

/** Why a chosen photo cannot be used, or null when it can. */
export function photoProblem(file: { size: number; type: string }): string | null {
  if (!PHOTO_TYPES.includes(file.type)) return "Choose a PNG, JPEG or WebP photo.";
  if (file.size > MAX_PHOTO_BYTES) {
    return `That photo is ${formatBytes(file.size)}. Photos can be up to ${formatBytes(MAX_PHOTO_BYTES)}, so choose a smaller one.`;
  }
  return null;
}

/** The same limits on a profile's code as the server's, so the form never lets the admin type what would be refused. */
export const MIN_CODE_CHARS = 6;
export const MAX_CODE_CHARS = 64;

/** Why a code cannot be used, or null. A new profile needs one; when editing, the caller skips an empty code. */
export function codeProblemFor(code: string, required: boolean): string | null {
  if (code.length >= MIN_CODE_CHARS && code.length <= MAX_CODE_CHARS) return null;
  const range = `${MIN_CODE_CHARS} to ${MAX_CODE_CHARS} characters`;
  return required ? `Choose a code of ${range}.` : `A new code needs ${range}. Leave it empty to keep the current one.`;
}

/** The sentence to show for a failed request: the server's own when there is one. */
export function reason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
