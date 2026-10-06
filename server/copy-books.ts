// Copies books from one store into another: how a library on this computer moves into an R2 bucket.
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./http.ts";
import { isBookId } from "./library.ts";
import { scopedStore } from "./storage.ts";
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

/** Where profiles.ts keeps the list of profiles, and the names it gives a profile's photo (one or the other at a time). */
const PROFILES_KEY = "profiles.json";
const SHARES_KEY = "shares.json";
const PHOTO_FILES = ["avatar.webp", "avatar.jpg"];

export type ProfileRef = { id: string; name: string };

export type ProfileCopy = ProfileRef & {
  books: CopyReport;
  /** The profile's photo was there and is now in the other store too. */
  photo: boolean;
};

export type LibraryReport = {
  /** The books at the root: a library from before profiles, or one that profiles have not moved yet. */
  books: CopyReport;
  profiles: {
    /**
     * none: the source has no profiles.
     * refused: the other store already has its own profiles.json, so nothing was copied for profiles.
     * copied: every profile is over with its books and photo, and profiles.json with them.
     * unfinished: some book had no room, so profiles.json was left out and a later run can finish the job.
     */
    outcome: "none" | "refused" | "copied" | "unfinished";
    list: ProfileCopy[];
  };
};

export type LibraryOptions = Omit<CopyOptions, "onBook"> & {
  /** `profile` is null for a book at the root. */
  onBook?: (id: string, outcome: keyof CopyReport, bytes: number, profile: ProfileRef | null) => void;
};

const sizeOf = async (store: ObjectStore, prefix: string): Promise<number> =>
  (await store.list(prefix)).reduce((sum, object) => sum + object.size, 0);

/** The profiles in a profiles.json, read as little as needed: copying them must not drop one because of a field added later. */
function profilesIn(data: Buffer): ProfileRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    parsed = null;
  }
  const list = isRecord(parsed) ? parsed.profiles : null;
  const valid =
    Array.isArray(list) &&
    list.every((profile) => isRecord(profile) && typeof profile.id === "string" && isBookId(profile.id) && typeof profile.name === "string");
  // Never guessed at: copying around a damaged list would leave profiles behind without a word.
  if (!valid) throw new Error(`${PROFILES_KEY} is damaged, so the profiles cannot be copied. Restore it from a copy, or mend it by hand.`);
  return list.map((profile) => ({ id: profile.id, name: profile.name }));
}

/** The photo bytes copied, or null when the profile has none. Through a file like the books, and removed once it is over. */
async function copyPhoto(from: ObjectStore, to: ObjectStore, id: string, tempDir: string): Promise<number | null> {
  let bytes: number | null = null;
  for (const name of PHOTO_FILES) {
    const path = join(tempDir, `${id}-${name}`);
    try {
      if (!(await from.download(name, path))) continue;
      // Measured first: the local store moves the file rather than copying it.
      const { size } = await stat(path);
      await to.putFile(name, path);
      bytes = (bytes ?? 0) + size;
    } finally {
      await rm(path, { force: true });
    }
  }
  return bytes;
}

/**
 * Copies the root books like copyBooks, then the profiles in profiles.json when the other store has none of its own:
 * each profile's books and photo, and profiles.json last, so the other store never lists a profile whose books are missing.
 * With profiles of its own the other store keeps them untouched (two lists are not merged): the user decides which to keep.
 * The limit counts everything the other store holds, wherever it sits, plus what this run has copied so far. Never changes `from`.
 */
export async function copyLibrary(from: ObjectStore, to: ObjectStore, options: LibraryOptions): Promise<LibraryReport> {
  const listed = await from.read(PROFILES_KEY);
  const refused = listed !== null && (await to.size(PROFILES_KEY)) !== null;
  // Read before anything is copied: a damaged list stops the run while the other store is still as it was.
  const profiles = listed !== null && !refused ? profilesIn(listed) : [];
  let used = (await sizeOf(to, "books/")) + (await sizeOf(to, "profiles/"));

  async function copyShelf(source: ObjectStore, target: ObjectStore, profile: ProfileRef | null): Promise<CopyReport> {
    const own = await sizeOf(target, "books/");
    return copyBooks(source, target, {
      tempDir: options.tempDir,
      // copyBooks counts only this shelf's books, so the room it is given is what the limit leaves after everything else.
      limit: options.limit === null ? null : options.limit - (used - own),
      onBook: (id, outcome, bytes) => {
        if (outcome === "copied") used += bytes;
        options.onBook?.(id, outcome, bytes, profile);
      },
    });
  }

  /** Small files (a place, notes, answers): copied whole and not counted against the limit, like a photo. */
  async function copyKept(source: ObjectStore, target: ObjectStore, prefix: string): Promise<void> {
    for (const { key } of await source.list(prefix)) {
      const data = await source.read(key);
      if (data) await target.write(key, data);
    }
  }

  const books = await copyShelf(from, to, null);
  if (listed === null) return { books, profiles: { outcome: "none", list: [] } };
  if (refused) return { books, profiles: { outcome: "refused", list: [] } };

  const list: ProfileCopy[] = [];
  for (const profile of profiles) {
    const folder = `profiles/${profile.id}/`;
    const [source, target] = [scopedStore(from, folder), scopedStore(to, folder)];
    const shelf = await copyShelf(source, target, profile);
    // A photo is small and its profile is no use without it, so it is not held to the limit, only counted in it.
    const photo = await copyPhoto(source, target, profile.id, options.tempDir);
    used += photo ?? 0;
    // What this reader kept of the books other profiles share with them.
    await copyKept(source, target, "shared/");
    list.push({ ...profile, books: shelf, photo: photo !== null });
  }
  const complete = list.every((profile) => profile.books.noRoom.length === 0);
  if (complete) {
    // Before profiles.json, which is what makes the profiles exist: the shares are there by the time they are.
    const shares = await from.read(SHARES_KEY);
    if (shares) await to.write(SHARES_KEY, shares);
    await to.write(PROFILES_KEY, listed);
  }
  return { books, profiles: { outcome: complete ? "copied" : "unfinished", list } };
}
