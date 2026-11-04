// One contract for every store. The R2 store runs only with DEEPREAD_TEST_R2=1 and the R2 settings of .env.local,
// in a folder of its own that is removed afterwards.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvFiles } from "./env.ts";
import { readStorageConfig } from "./storage-config.ts";
import { countedStore, createLocalStore, scopedStore } from "./storage.ts";
import type { ObjectStore } from "./storage.ts";

type Setup = { store: ObjectStore; cleanup: () => Promise<void> };

async function localSetup(): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "deepread-store-"));
  return { store: createLocalStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

// A profile's library: the same contract, inside profiles/<id>/ of a store that holds other things too.
async function scopedSetup(): Promise<Setup> {
  const { store, cleanup } = await localSetup();
  return { store: scopedStore(store, "profiles/reader-a1b2c3/"), cleanup };
}

async function r2Setup(): Promise<Setup> {
  loadEnvFiles();
  const config = readStorageConfig(process.env);
  if (config.kind !== "r2") throw new Error("DEEPREAD_TEST_R2 needs DEEPREAD_STORAGE=r2 and the R2 settings in .env.local");
  const { openR2Store } = await import("./storage-r2.ts");
  const store = await openR2Store({ ...config, prefix: `${config.prefix}test-${randomUUID()}/` });
  return { store, cleanup: () => store.removeAll("") };
}

// A library's store: the same contract, while it counts the bytes of its books.
const counted = (setup: () => Promise<Setup>) => async (): Promise<Setup> => {
  const { store, cleanup } = await setup();
  return { store: countedStore(store, "books/"), cleanup };
};

const stores: Array<[string, () => Promise<Setup>]> = [
  ["local", localSetup],
  ["scoped local", scopedSetup],
  ["counted local", counted(localSetup)],
];
if (process.env.DEEPREAD_TEST_R2 === "1") stores.push(["r2", r2Setup], ["counted r2", counted(r2Setup)]);

async function text(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  return stream && new Response(stream).text();
}

describe.each(stores)("%s store", (_name, setup) => {
  let store: ObjectStore;
  let cleanup: () => Promise<void>;
  let scratch: string;

  beforeAll(async () => {
    ({ store, cleanup } = await setup());
    scratch = await mkdtemp(join(tmpdir(), "deepread-scratch-"));
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await rm(scratch, { recursive: true, force: true });
  }, 30_000);

  it("should write, read, measure, stream a range of, list and remove objects", async () => {
    await store.write("books/a/meta.json", '{"id":"a"}');
    await store.write("books/a/cache/k.json", new TextEncoder().encode("cached"));
    await store.write("books/b/meta.json", "{}");
    await store.write("other/x.json", "not a book");

    expect((await store.read("books/a/meta.json"))?.toString()).toBe('{"id":"a"}');
    expect(await store.size("books/a/cache/k.json")).toBe(6);
    expect(await text(await store.stream("books/a/cache/k.json", { start: 1, end: 3 }))).toBe("ach");
    expect(await text(await store.stream("books/a/cache/k.json"))).toBe("cached");

    const listed = await store.list("books/");
    expect(listed.sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { key: "books/a/cache/k.json", size: 6 },
      { key: "books/a/meta.json", size: 10 },
      { key: "books/b/meta.json", size: 2 },
    ]);

    await store.write("books/a/meta.json", '{"id":"a","v":2}');
    expect((await store.read("books/a/meta.json"))?.toString()).toBe('{"id":"a","v":2}');

    await store.remove(["books/b/meta.json", "books/never-was.json"]);
    await store.removeAll("books/a/");
    expect(await store.list("books/")).toEqual([]);
    expect(await store.size("other/x.json")).toBe(10);
  }, 30_000);

  it("should answer null, false and empty for what is not there", async () => {
    expect(await store.read("books/none/meta.json")).toBeNull();
    expect(await store.size("books/none/meta.json")).toBeNull();
    expect(await store.stream("books/none/source.pdf")).toBeNull();
    expect(await store.download("books/none/source.pdf", join(scratch, "none.pdf"))).toBe(false);
    expect(await store.list("books/none/")).toEqual([]);
    await store.removeAll("books/none/");
  }, 30_000);

  it("should store a file from this computer and copy it back", async () => {
    const source = join(scratch, "upload.pdf");
    await writeFile(source, "%PDF-1.7 a whole book");
    await store.putFile("books/c/source.pdf", source);
    // The caller removes what is left of the upload; the stored copy must not depend on it.
    await rm(source, { force: true });

    const copy = join(scratch, "copy.pdf");
    expect(await store.download("books/c/source.pdf", copy)).toBe(true);
    expect(await readFile(copy, "utf8")).toBe("%PDF-1.7 a whole book");
    await store.removeAll("books/c/");
  }, 30_000);
});

describe("scopedStore", () => {
  it("should keep a scope's objects inside its folder and out of reach of its neighbours", async () => {
    const { store, cleanup } = await localSetup();
    try {
      const mine = scopedStore(store, "profiles/me-111111/");
      const theirs = scopedStore(store, "profiles/them-222222/");
      await mine.write("books/a/meta.json", "{}");
      await theirs.write("books/b/meta.json", "{}");

      expect(await store.list("profiles/")).toHaveLength(2);
      expect((await store.read("profiles/me-111111/books/a/meta.json"))?.toString()).toBe("{}");
      expect(await mine.list("")).toEqual([{ key: "books/a/meta.json", size: 2 }]);
      expect(await mine.read("books/b/meta.json")).toBeNull();
      await expect(mine.read("../them-222222/books/b/meta.json")).rejects.toThrow(/invalid storage key/);

      await mine.removeAll("");
      expect(await theirs.list("")).toEqual([{ key: "books/b/meta.json", size: 2 }]);
    } finally {
      await cleanup();
    }
  });
});

describe("countedStore", () => {
  const sum = async (store: ObjectStore): Promise<number> => (await store.list("books/")).reduce((total, object) => total + object.size, 0);

  it("should list once, count every change made through it, and list again after a change that failed", async () => {
    const { store: inner, cleanup } = await localSetup();
    const scratch = await mkdtemp(join(tmpdir(), "deepread-scratch-"));
    let listings = 0;
    let failing = false;
    const watched: ObjectStore = {
      ...inner,
      list: (prefix, options) => (listings++, inner.list(prefix, options)),
      write: (key, data) => (failing ? Promise.reject(new Error("the bucket did not answer")) : inner.write(key, data)),
    };
    const store = countedStore(watched, "books/");
    try {
      await inner.write("books/a/meta.json", "{}");
      await inner.write("other/x.json", "not a book");
      expect(await store.used()).toBe(2);

      await store.write("books/a/meta.json", '{"v":2}');
      await store.write("books/a/notes.json", new TextEncoder().encode("[1]"));
      await writeFile(join(scratch, "upload.pdf"), "%PDF-1.7 a whole book");
      await store.putFile("books/a/source.pdf", join(scratch, "upload.pdf"));
      await store.remove(["books/a/notes.json", "books/never-was.json"]);
      await store.write("other/y.json", "not a book either");
      expect(await store.used()).toBe(await sum(inner));
      await store.write("books/b/meta.json", "{}");
      await store.removeAll("books/a/");
      expect([await store.used(), await sum(inner), listings]).toEqual([2, 2, 1]);

      failing = true;
      await expect(store.write("books/c/meta.json", "{}")).rejects.toThrow(/did not answer/);
      failing = false;
      // The write failed, but may have landed: R2 can store an object and still fail the request.
      await inner.write("books/c/meta.json", "{}");
      expect([await store.used(), listings]).toEqual([4, 2]);
    } finally {
      await cleanup();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("should not keep a count listed while a change was being made", async () => {
    const { store: inner, cleanup } = await localSetup();
    let listings = 0;
    let listed!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => { listed = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = countedStore({
      ...inner,
      async list(prefix, options) {
        const objects = await inner.list(prefix, options);
        // The first listing is taken, then held back while a write lands.
        if (++listings === 1) {
          listed();
          await gate;
        }
        return objects;
      },
    }, "books/");
    try {
      const first = store.used();
      await seen;
      await store.write("books/a/meta.json", "{}");
      release();
      expect(await first).toBe(0);
      expect([await store.used(), await store.used(), listings]).toEqual([2, 2, 2]);
    } finally {
      await cleanup();
    }
  });
});
