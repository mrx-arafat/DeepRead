// One contract for every store. The R2 store runs only with DEEPREAD_TEST_R2=1 and the R2 settings of .env.local,
// in a folder of its own that is removed afterwards.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvFiles } from "./env.ts";
import { readStorageConfig } from "./storage-config.ts";
import { createLocalStore } from "./storage.ts";
import type { ObjectStore } from "./storage.ts";

type Setup = { store: ObjectStore; cleanup: () => Promise<void> };

async function localSetup(): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "deepread-store-"));
  return { store: createLocalStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function r2Setup(): Promise<Setup> {
  loadEnvFiles();
  const config = readStorageConfig(process.env);
  if (config.kind !== "r2") throw new Error("DEEPREAD_TEST_R2 needs DEEPREAD_STORAGE=r2 and the R2 settings in .env.local");
  const { openR2Store } = await import("./storage-r2.ts");
  const store = await openR2Store({ ...config, prefix: `${config.prefix}test-${randomUUID()}/` });
  return { store, cleanup: () => store.removeAll("") };
}

const stores: Array<[string, () => Promise<Setup>]> = [["local", localSetup]];
if (process.env.DEEPREAD_TEST_R2 === "1") stores.push(["r2", r2Setup]);

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
