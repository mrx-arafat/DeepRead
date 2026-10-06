// Encryption at rest over a store in a folder of its own: what goes in comes back out, and what lies on disk is no use
// without the key. A fixed fake key; never the real one.
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEncryptionKey, CHUNK_BYTES, createEncryptedStore, encryptInPlace, refuseEncryptedObjects } from "./encrypted-store.ts";
import { createLocalStore } from "./storage.ts";
import type { ObjectStore, StoredObject } from "./storage.ts";

const KEY = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
const OTHER_KEY = Buffer.alloc(32, 7);
// AES-GCM's tag, at the end of every chunk.
const TAG_BYTES = 16;
const NAMES_SETTING = /DEEPREAD_ENCRYPTION_KEY/;

/** `length` bytes that differ from one chunk to the next, so a chunk read from the wrong place shows. */
function content(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let at = 0; at < length; at += 1) bytes[at] = (at * 31 + Math.floor(at / CHUNK_BYTES)) % 251;
  return bytes;
}

async function bytesOf(stream: ReadableStream<Uint8Array> | null): Promise<Buffer | null> {
  return stream && Buffer.from(await new Response(stream).arrayBuffer());
}

const sorted = (objects: StoredObject[]): StoredObject[] => [...objects].sort((a, b) => a.key.localeCompare(b.key));

let root: string;
let scratch: string;
let raw: ObjectStore;
let store: ObjectStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deepread-sealed-"));
  scratch = await mkdtemp(join(tmpdir(), "deepread-scratch-"));
  raw = createLocalStore(root);
  store = createEncryptedStore(raw, KEY);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe("createEncryptedStore", () => {
  it("should read back what it wrote at every size around a chunk boundary, and report plaintext sizes", async () => {
    const sizes = [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES + 5];
    for (const size of sizes) {
      const key = `books/a/${size}.bin`;
      await store.write(key, content(size));
      expect(await store.read(key)).toEqual(content(size));
      expect(await bytesOf(await store.stream(key))).toEqual(content(size));
      expect(await store.size(key)).toBe(size);
    }
    const expected = sorted(sizes.map((size) => ({ key: `books/a/${size}.bin`, size })));
    expect(sorted(await store.list("books/"))).toEqual(expected);
    // A store that saw none of them written measures them from what is on disk alone.
    const fresh = createEncryptedStore(raw, KEY);
    expect(sorted(await fresh.list("books/"))).toEqual(expected);
    expect(await fresh.size(`books/a/${CHUNK_BYTES}.bin`)).toBe(CHUNK_BYTES);
  });

  it("should stream any byte range, fetching only the chunks it touches", async () => {
    const data = content(3 * CHUNK_BYTES + 100);
    const key = "books/a/source.pdf";
    await store.write(key, data);
    const ranges = [
      { start: 10, end: 20 },
      { start: CHUNK_BYTES - 5, end: 2 * CHUNK_BYTES + 5 },
      { start: CHUNK_BYTES, end: 2 * CHUNK_BYTES - 1 },
      { start: 2 * CHUNK_BYTES + 3, end: data.length - 1 },
      { start: 3 * CHUNK_BYTES, end: 10 * CHUNK_BYTES },
    ];
    for (const range of ranges) {
      expect(await bytesOf(await store.stream(key, range))).toEqual(data.subarray(range.start, range.end + 1));
    }
    expect(await bytesOf(await store.stream(key, { start: data.length, end: data.length + 10 }))).toEqual(Buffer.alloc(0));

    let fetched = 0;
    const watched = createEncryptedStore(
      {
        ...raw,
        stream: (name, range) => {
          fetched += range ? range.end - range.start + 1 : Infinity;
          return raw.stream(name, range);
        },
      },
      KEY,
    );
    const middle = { start: 2 * CHUNK_BYTES + 10, end: 2 * CHUNK_BYTES + 20 };
    expect(await bytesOf(await watched.stream(key, middle))).toEqual(data.subarray(middle.start, middle.end + 1));
    expect(fetched).toBeLessThan(2 * CHUNK_BYTES);
  });

  it("should leave nothing readable on disk", async () => {
    const book = Buffer.from("A sentence only this book contains. ".repeat(5000));
    await store.write("books/a/book.json", book);
    const upload = join(scratch, "upload.pdf");
    await writeFile(upload, book);
    await store.putFile("books/a/source.pdf", upload);

    const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
    expect(files).toHaveLength(2);
    for (const file of files) expect((await readFile(join(file.parentPath, file.name))).includes("only this book")).toBe(false);
  });

  it("should refuse a wrong key, a changed byte, a cut-short object and one moved to another key", async () => {
    const data = content(2 * CHUNK_BYTES);
    const key = "books/a/source.pdf";
    const path = join(root, key);
    const copy = join(scratch, "copy.pdf");
    await store.write(key, data);
    const intact = await readFile(path);

    const stranger = createEncryptedStore(raw, OTHER_KEY);
    await expect(stranger.read(key)).rejects.toThrow(/different DEEPREAD_ENCRYPTION_KEY/);
    await expect(stranger.stream(key, { start: 0, end: 9 })).rejects.toThrow(/different DEEPREAD_ENCRYPTION_KEY/);
    await expect(stranger.download(key, copy)).rejects.toThrow(/different DEEPREAD_ENCRYPTION_KEY/);

    const changed = Buffer.from(intact);
    changed[changed.length - 100]! ^= 1;
    await writeFile(path, changed);
    await expect(store.read(key)).rejects.toThrow(NAMES_SETTING);
    await expect(store.stream(key, { start: data.length - 10, end: data.length - 1 })).rejects.toThrow(NAMES_SETTING);
    // Each chunk stands on its own: the untouched first one still reads.
    expect(await bytesOf(await store.stream(key, { start: 0, end: 9 }))).toEqual(data.subarray(0, 10));

    // Cut by its whole last chunk: what is left is the right size for one chunk, but that one was not sealed as the last.
    await writeFile(path, intact.subarray(0, intact.length - (CHUNK_BYTES + TAG_BYTES)));
    await expect(store.read(key)).rejects.toThrow(NAMES_SETTING);
    await expect(store.stream(key)).rejects.toThrow(NAMES_SETTING);
    await expect(store.download(key, copy)).rejects.toThrow(NAMES_SETTING);
    await expect(stat(copy)).rejects.toThrow(/ENOENT/);
    await writeFile(path, intact.subarray(0, intact.length - 1000));
    await expect(store.read(key)).rejects.toThrow(NAMES_SETTING);

    await writeFile(path, intact);
    await mkdir(join(root, "books/b"), { recursive: true });
    await copyFile(path, join(root, "books/b/source.pdf"));
    await expect(store.read("books/b/source.pdf")).rejects.toThrow(NAMES_SETTING);
    expect(await store.read(key)).toEqual(data);
  });

  it("should fail a range read of an object cut short while it is read, rather than end early", async () => {
    const data = content(5 * CHUNK_BYTES);
    const key = "books/a/source.pdf";
    const path = join(root, key);
    await store.write(key, data);
    const whole = (await stat(path)).size;
    // Cut in place by its last three chunks just after its size is read, as another program could between the two.
    const racing = createEncryptedStore(
      {
        ...raw,
        size: async (name) => {
          const size = await raw.size(name);
          await truncate(path, whole - 3 * (CHUNK_BYTES + TAG_BYTES));
          return size;
        },
      },
      KEY,
    );
    await expect(racing.stream(key, { start: CHUNK_BYTES + 10, end: 4 * CHUNK_BYTES - 10 }).then(bytesOf)).rejects.toThrow(NAMES_SETTING);
  });

  it("should pass objects from before encryption was turned on through unchanged", async () => {
    const pdf = content(CHUNK_BYTES + 10);
    await raw.write("books/old/meta.json", '{"id":"old"}');
    await raw.write("books/old/source.pdf", pdf);
    await raw.write("books/old/notes.json", "");

    expect((await store.read("books/old/meta.json"))?.toString()).toBe('{"id":"old"}');
    expect(await store.read("books/old/notes.json")).toEqual(Buffer.alloc(0));
    expect(await store.size("books/old/source.pdf")).toBe(pdf.length);
    expect(await bytesOf(await store.stream("books/old/source.pdf", { start: 5, end: CHUNK_BYTES + 2 }))).toEqual(
      pdf.subarray(5, CHUNK_BYTES + 3),
    );
    expect(sorted(await store.list("books/"))).toEqual([
      { key: "books/old/meta.json", size: 12 },
      { key: "books/old/notes.json", size: 0 },
      { key: "books/old/source.pdf", size: pdf.length },
    ]);
    const copy = join(scratch, "copy.pdf");
    expect(await store.download("books/old/source.pdf", copy)).toBe(true);
    expect(await readFile(copy)).toEqual(pdf);
  });

  it("should store a file from this computer and copy it back, leaving no file of its own behind", async () => {
    const own = async (): Promise<string[]> => (await readdir(tmpdir())).filter((name) => name.startsWith("deepread-sealing-"));
    const before = await own();
    const data = content(2 * CHUNK_BYTES + 7);
    const upload = join(scratch, "upload.pdf");
    await writeFile(upload, data);
    await store.putFile("books/c/source.pdf", upload);
    // The caller removes what is left of the upload; the stored copy must not depend on it.
    await rm(upload, { force: true });
    await expect(store.putFile("books/d/source.pdf", join(scratch, "missing.pdf"))).rejects.toThrow(/ENOENT/);

    const copy = join(scratch, "copy.pdf");
    expect(await store.download("books/c/source.pdf", copy)).toBe(true);
    expect(await readFile(copy)).toEqual(data);
    expect(await store.download("books/none/source.pdf", join(scratch, "none.pdf"))).toBe(false);
    expect(await store.size("books/d/source.pdf")).toBeNull();
    expect(await own()).toEqual(before);
  });
});

describe("refuseEncryptedObjects", () => {
  it("should refuse an encrypted object, naming DEEPREAD_ENCRYPTION_KEY, and pass plaintext through", async () => {
    await store.write("books/a/meta.json", "{}");
    await store.write("books/a/source.pdf", content(2 * CHUNK_BYTES));
    await raw.write("books/old/meta.json", '{"id":"old"}');
    const keyless = refuseEncryptedObjects(raw);
    const copy = join(scratch, "copy.pdf");

    await expect(keyless.read("books/a/meta.json")).rejects.toThrow(/DEEPREAD_ENCRYPTION_KEY is not set/);
    await expect(keyless.stream("books/a/source.pdf")).rejects.toThrow(/DEEPREAD_ENCRYPTION_KEY is not set/);
    await expect(keyless.stream("books/a/source.pdf", { start: 0, end: 99 })).rejects.toThrow(/DEEPREAD_ENCRYPTION_KEY is not set/);
    await expect(keyless.stream("books/a/source.pdf", { start: 100, end: 200 })).rejects.toThrow(/DEEPREAD_ENCRYPTION_KEY is not set/);
    await expect(keyless.download("books/a/source.pdf", copy)).rejects.toThrow(/DEEPREAD_ENCRYPTION_KEY is not set/);
    await expect(stat(copy)).rejects.toThrow(/ENOENT/);

    expect((await keyless.read("books/old/meta.json"))?.toString()).toBe('{"id":"old"}');
    expect((await bytesOf(await keyless.stream("books/old/meta.json")))?.toString()).toBe('{"id":"old"}');
    expect((await bytesOf(await keyless.stream("books/old/meta.json", { start: 2, end: 3 })))?.toString()).toBe("id");
    expect(await keyless.download("books/old/meta.json", copy)).toBe(true);
    expect(await keyless.stream("books/none/source.pdf", { start: 5, end: 9 })).toBeNull();
  });
});

describe("checkEncryptionKey", () => {
  it("should stop a start whose key is missing or wrong, even in a half-encrypted library whose first objects are plaintext", async () => {
    await checkEncryptionKey(raw, null);
    // From before the key was set: what a start finds first.
    await raw.write("profiles.json", '{"profiles":[]}');
    await raw.write("books/aaa-11111111/meta.json", "{}");
    await checkEncryptionKey(raw, null);
    await checkEncryptionKey(raw, KEY);

    await store.write("profiles/reader-a1b2c3/books/zzz-22222222/meta.json", "{}");
    await store.write("profiles/reader-a1b2c3/books/zzz-33333333/meta.json", "{}");
    await expect(checkEncryptionKey(raw, null)).rejects.toThrow(/zzz-\d{8}\/meta\.json is encrypted, but DEEPREAD_ENCRYPTION_KEY is not set/);
    await expect(checkEncryptionKey(raw, OTHER_KEY)).rejects.toThrow(/different DEEPREAD_ENCRYPTION_KEY/);
    await checkEncryptionKey(raw, KEY);

    // One damaged header among good ones never keeps DeepRead from starting: reading that book reports it.
    const damagedPath = join(root, "profiles/reader-a1b2c3/books/zzz-22222222/meta.json");
    const bytes = await readFile(damagedPath);
    bytes[10]! ^= 1;
    await writeFile(damagedPath, bytes);
    await checkEncryptionKey(raw, KEY);
  });
});

describe("encryptInPlace", () => {
  it("should encrypt the library's plaintext objects once, and leave the data folder's other files alone", async () => {
    const plain: Record<string, Buffer> = {
      "books/a/meta.json": Buffer.from('{"id":"a"}'),
      "books/a/source.pdf": content(2 * CHUNK_BYTES + 3),
      "profiles/reader-a1b2c3/avatar.webp": content(500),
      "profiles.json": Buffer.from('{"profiles":[]}'),
    };
    for (const [key, data] of Object.entries(plain)) await raw.write(key, data);
    await store.write("books/b/meta.json", '{"id":"b"}');
    const already = await raw.read("books/b/meta.json");
    // Read by other parts of DeepRead as they are: encrypting them would break it.
    await raw.write("session-secret", "secret");
    await raw.write("openrouter.json", "{}");

    expect(await encryptInPlace(raw, KEY, { tempDir: scratch })).toEqual({ encrypted: 4, skipped: 1 });
    for (const [key, data] of Object.entries(plain)) {
      expect(await raw.read(key)).not.toEqual(data);
      expect(await store.read(key)).toEqual(data);
    }
    expect(await raw.read("books/b/meta.json")).toEqual(already);
    expect((await raw.read("session-secret"))?.toString()).toBe("secret");
    expect((await raw.read("openrouter.json"))?.toString()).toBe("{}");

    expect(await encryptInPlace(raw, KEY, { tempDir: scratch })).toEqual({ encrypted: 0, skipped: 5 });
    expect(await readdir(scratch)).toEqual([]);
  });

  it("should put an object back unencrypted when what was stored does not read back, even at the same size", async () => {
    const data = content(CHUNK_BYTES + 9);
    await raw.write("books/a/source.pdf", data);
    // Damages the header of what it is given sealed, keeping its size: what a faulty disk or bucket could do.
    const faulty: ObjectStore = {
      ...raw,
      async putFile(key, path) {
        await raw.putFile(key, path);
        const bytes = await readFile(join(root, key));
        if (bytes.subarray(0, 6).toString("latin1") === "\0DRENC") {
          bytes[10]! ^= 1;
          await writeFile(join(root, key), bytes);
        }
      },
    };

    await expect(encryptInPlace(faulty, KEY, { tempDir: scratch })).rejects.toThrow(/did not read back the same/);
    expect(await raw.read("books/a/source.pdf")).toEqual(data);
    expect(await readdir(scratch)).toEqual([]);
  });
});
