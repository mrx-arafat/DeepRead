// Copies books from one store into another: how a library on this computer moves into an R2 bucket.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isBookId } from "./library.ts";
import type { ObjectStore, StoredObject } from "./storage.ts";

export type CopyReport = {
  copied: string[];
  /** Already in the other store, and left as they are there. */
  skipped: string[];
  /** Would have taken the other store past its limit. */
  noRoom: string[];
};

export type CopyOptions = {
  /** A folder on this computer the files pass through. */
  tempDir: string;
  limit: number | null;
  onBook?: (id: string, outcome: keyof CopyReport, bytes: number) => void;
};

const META = "meta.json";

/** The books in `store`, each with its objects. A folder without meta.json is not a book (see library.ts). */
async function booksIn(store: ObjectStore): Promise<{ books: Map<string, StoredObject[]>; used: number }> {
  const objects = await store.list("books/");
  const folders = new Map<string, StoredObject[]>();
  for (const object of objects) {
    const id = object.key.split("/")[1]!;
    if (!isBookId(id)) continue;
    folders.set(id, [...(folders.get(id) ?? []), object]);
  }
  const books = new Map([...folders].filter(([id, files]) => files.some((file) => file.key === `books/${id}/${META}`)));
  return { books, used: objects.reduce((sum, object) => sum + object.size, 0) };
}

/**
 * Copies every book in `from` that `to` does not have yet, and never changes `from`.
 * meta.json goes last, so a copy cut short is no book at all, and the next start of DeepRead clears it away.
 */
export async function copyBooks(from: ObjectStore, to: ObjectStore, options: CopyOptions): Promise<CopyReport> {
  const source = await booksIn(from);
  const target = await booksIn(to);
  let used = target.used;
  const report: CopyReport = { copied: [], skipped: [], noRoom: [] };

  for (const [id, files] of [...source.books].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    const outcome: keyof CopyReport = target.books.has(id)
      ? "skipped"
      : options.limit !== null && used + bytes > options.limit
        ? "noRoom"
        : "copied";
    if (outcome === "copied") {
      const ordered = [...files].sort((a, b) => Number(a.key.endsWith(`/${META}`)) - Number(b.key.endsWith(`/${META}`)));
      try {
        for (const file of ordered) {
          // Through a file, so a 300 MB PDF is never held in memory.
          const path = join(options.tempDir, `${id}-${file.key.split("/").pop()}`);
          try {
            if (await from.download(file.key, path)) await to.putFile(file.key, path);
          } finally {
            // The R2 store streams the file rather than moving it: removed now, so the copies never pile up on this disk.
            await rm(path, { force: true });
          }
        }
      } catch (error) {
        await to.removeAll(`books/${id}/`).catch(() => {});
        throw error;
      }
      used += bytes;
    }
    report[outcome].push(id);
    options.onBook?.(id, outcome, bytes);
  }
  return report;
}
