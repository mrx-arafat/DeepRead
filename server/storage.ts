// Where the library keeps its files: a folder on this computer (here) or an R2 bucket (storage-r2.ts).
// Keys are paths like "books/<id>/meta.json". A store knows nothing about books: library.ts gives the keys meaning.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { StorageUsage } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";

/** Inclusive byte positions, as in an HTTP Range header. */
export type ByteRange = { start: number; end: number };

export type StoredObject = { key: string; size: number };

export type ObjectStore = {
  kind: StorageUsage["where"];
  /** The whole object, or null when there is none. For small files: a PDF is streamed or downloaded. */
  read(key: string): Promise<Buffer | null>;
  /** Its size in bytes, or null when there is none. */
  size(key: string): Promise<number | null>;
  /** All of the object, or `range` of it. Null when there is none. */
  stream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  /** Replaces the object whole: a reader sees the old one or the new one, never part of either. */
  write(key: string, data: string | Uint8Array): Promise<void>;
  /** Stores the file at `path` on this computer. It may be moved rather than copied; the caller removes what is left. */
  putFile(key: string, path: string): Promise<void>;
  /** Copies the object to `path` on this computer. False when there is none. */
  download(key: string, path: string): Promise<boolean>;
  /**
   * Every object under `prefix`, which is "" or ends in "/". With `sized: false` only the keys are wanted: each size is the
   * bytes stored, and no object is read to measure it, so a listing never costs one request per object.
   */
  list(prefix: string, options?: { sized?: boolean }): Promise<StoredObject[]>;
  /** Removes these objects. One that is already gone is no error. */
  remove(keys: string[]): Promise<void>;
  /** Removes every object under `prefix`, which is "" or ends in "/". */
  removeAll(prefix: string): Promise<void>;
};

export function isFolderPrefix(prefix: string): boolean {
  return prefix === "" || prefix.endsWith("/");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * `store` seen from inside the folder `prefix` (which ends in "/"): keys are relative to it, and nothing outside it can
 * be read, listed or removed. Each profile's library lives in one, so it cannot reach another profile's books.
 */
export function scopedStore(store: ObjectStore, prefix: string): ObjectStore {
  if (prefix === "" || !isFolderPrefix(prefix)) throw new Error(`a scope is a folder ending in "/": ${JSON.stringify(prefix)}`);
  const full = (key: string): string => {
    // The local store resolves paths, so a ".." would climb out of the scope into a neighbour's folder.
    if (key.split("/").some((part) => part === ".." || part === ".")) throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
    return prefix + key;
  };
  // Async throughout, so a refused key is a rejected promise like any other storage failure.
  return {
    kind: store.kind,
    read: async (key) => store.read(full(key)),
    size: async (key) => store.size(full(key)),
    stream: async (key, range) => store.stream(full(key), range),
    write: async (key, data) => store.write(full(key), data),
    putFile: async (key, path) => store.putFile(full(key), path),
    download: async (key, path) => store.download(full(key), path),
    async list(folder, options) {
      return (await store.list(full(folder), options)).map((object) => ({ key: object.key.slice(prefix.length), size: object.size }));
    },
    remove: async (keys) => store.remove(keys.map(full)),
    removeAll: async (folder) => store.removeAll(full(folder)),
  };
}

/** A store that also knows how many bytes its objects under one folder take. */
export type CountedStore = ObjectStore & {
  /** The bytes of every object under the folder, as list() would add them up: listed once, then kept up to date. */
  used(): Promise<number>;
};

/**
 * `store`, also counting the bytes its objects under `prefix` (a folder) take, so the count is listed once and not on every
 * look. After the first listing, each change made through here updates the count. That keeps it true while nothing else
 * changes those objects: only one DeepRead may use a store (README), and a library makes every change to its own books.
 * A change that fails may have been made in part, so the count lists the store again next time.
 */
export function countedStore(store: ObjectStore, prefix: string): CountedStore {
  if (!isFolderPrefix(prefix)) throw new Error(`a folder prefix ends in "/": ${JSON.stringify(prefix)}`);
  // Each object's bytes, and their sum: from a listing taken while no change was under way, and every change since.
  let known: { sizes: Map<string, number>; bytes: number } | null = null;
  // Moves on as a change starts and again as it ends, so a listing taken meanwhile is seen to have overlapped one.
  let changes = 0;

  const set = (key: string, size: number): void => {
    if (!known || !key.startsWith(prefix)) return;
    known.bytes += size - (known.sizes.get(key) ?? 0);
    known.sizes.set(key, size);
  };
  const drop = (keys: Iterable<string>): void => {
    if (!known) return;
    for (const key of keys) {
      known.bytes -= known.sizes.get(key) ?? 0;
      known.sizes.delete(key);
    }
  };
  // Each update says what the store holds once the change is made, whatever a listing taken meanwhile saw of it.
  async function change(work: () => Promise<void>, update: () => void): Promise<void> {
    changes++;
    try {
      await work();
      update();
    } catch (error) {
      known = null;
      throw error;
    } finally {
      changes++;
    }
  }

  return {
    kind: store.kind,
    read: (key) => store.read(key),
    size: (key) => store.size(key),
    stream: (key, range) => store.stream(key, range),
    write: (key, data) => change(() => store.write(key, data), () => set(key, typeof data === "string" ? Buffer.byteLength(data) : data.byteLength)),
    async putFile(key, path) {
      // Measured first: the local store moves the file rather than copying it.
      const { size } = await stat(path);
      await change(() => store.putFile(key, path), () => set(key, size));
    },
    download: (key, path) => store.download(key, path),
    list: (folder, options) => store.list(folder, options),
    remove: (keys) => change(() => store.remove(keys), () => drop(keys)),
    removeAll: (folder) => change(() => store.removeAll(folder), () => drop([...(known?.sizes.keys() ?? [])].filter((key) => key.startsWith(folder)))),
    async used() {
      if (known) return known.bytes;
      const at = changes;
      const objects = await store.list(prefix);
      const bytes = objects.reduce((sum, object) => sum + object.size, 0);
      // A change made while listing may be missing from it: this count answers, but is not kept.
      if (changes === at && !known) known = { sizes: new Map(objects.map((object) => [object.key, object.size])), bytes };
      return bytes;
    },
  };
}

// writeFileAtomic's file in flight, which is not an object of its own.
const IN_FLIGHT = /\.[0-9a-f-]{36}\.tmp$/;

/** The objects are files under `root`, at their key. */
export function createLocalStore(root: string): ObjectStore {
  const base = resolve(root);

  const pathOf = (key: string): string => {
    const path = join(base, key);
    // Keys are built from checked ids in library.ts; this only makes sure that no key can reach outside the folder.
    if (path !== base && !path.startsWith(base + sep)) throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
    return path;
  };

  const folderOf = (prefix: string): string => {
    if (!isFolderPrefix(prefix)) throw new Error(`a folder prefix ends in "/": ${JSON.stringify(prefix)}`);
    return pathOf(prefix);
  };

  return {
    kind: "local",

    async read(key) {
      try {
        return await readFile(pathOf(key));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async size(key) {
      try {
        return (await stat(pathOf(key))).size;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async stream(key, range) {
      let handle;
      try {
        // Opened before streaming starts, so a missing file is a null here and not an error half way through a response.
        handle = await open(pathOf(key));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      const stream = handle.createReadStream(range ? { start: range.start, end: range.end } : {});
      return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    },

    async write(key, data) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, data);
    },

    async putFile(key, path) {
      const target = pathOf(key);
      await mkdir(dirname(target), { recursive: true });
      try {
        await rename(path, target);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
        // Another disk: copied next to its place first, so the object appears whole or not at all.
        const temp = `${target}.${randomUUID()}.tmp`;
        try {
          await copyFile(path, temp);
          await rename(temp, target);
        } finally {
          await rm(temp, { force: true });
        }
      }
    },

    async download(key, path) {
      try {
        await copyFile(pathOf(key), path);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },

    async list(prefix) {
      let entries;
      try {
        entries = await readdir(folderOf(prefix), { recursive: true, withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const files = entries.filter((entry) => entry.isFile() && !IN_FLIGHT.test(entry.name));
      const objects = await Promise.all(
        files.map(async (entry): Promise<StoredObject | null> => {
          const path = join(entry.parentPath, entry.name);
          try {
            return { key: relative(base, path).split(sep).join("/"), size: (await stat(path)).size };
          } catch (error) {
            // Removed between the listing and now.
            if (isMissing(error)) return null;
            throw error;
          }
        }),
      );
      return objects.filter((object) => object !== null);
    },

    async remove(keys) {
      await Promise.all(keys.map((key) => rm(pathOf(key), { force: true })));
    },

    async removeAll(prefix) {
      const folder = folderOf(prefix);
      if (folder === base) {
        // The folder itself stays: it may be the data folder, holding more than the library.
        for (const entry of await readdir(base).catch(() => [])) await rm(join(base, entry), { recursive: true, force: true });
        return;
      }
      await rm(folder, { recursive: true, force: true });
    },
  };
}
