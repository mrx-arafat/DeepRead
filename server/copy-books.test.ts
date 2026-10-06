import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyBooks } from "./copy-books.ts";
import { createLocalStore } from "./storage.ts";
import type { ObjectStore } from "./storage.ts";

describe("copyBooks", () => {
  let roots: string[];
  let from: ObjectStore;
  let to: ObjectStore;
  let tempDir: string;

  beforeEach(async () => {
    roots = await Promise.all(["from", "to", "temp"].map((name) => mkdtemp(join(tmpdir(), `deepread-copy-${name}-`))));
    [from, to] = roots.map((root) => createLocalStore(root)) as [ObjectStore, ObjectStore];
    tempDir = roots[2]!;
    await from.write("books/alpha-11111111/source.pdf", "%PDF-alpha");
    await from.write("books/alpha-11111111/book.json", "{}");
    await from.write("books/alpha-11111111/cache/answer.json", '{"text":"kept"}');
    await from.write("books/alpha-11111111/meta.json", '{"id":"alpha-11111111"}');
    await from.write("books/beta-22222222/source.pdf", "%PDF-beta");
    await from.write("books/beta-22222222/meta.json", '{"id":"beta-22222222"}');
    // Half added when DeepRead stopped: not a book, so not copied.
    await from.write("books/gamma-33333333/source.pdf", "%PDF-gamma");
    await to.write("books/beta-22222222/meta.json", '{"id":"beta-22222222","already":true}');
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const keys = async (store: ObjectStore) => (await store.list("books/")).map((object) => object.key).sort();

  it("should copy the books the other store lacks, whole, and leave both the source and the books it has alone", async () => {
    const before = await keys(from);
    const report = await copyBooks(from, to, { tempDir, limit: null });

    expect(report).toEqual({ copied: ["alpha-11111111"], skipped: ["beta-22222222"], noRoom: [] });
    expect(await keys(to)).toEqual([
      "books/alpha-11111111/book.json",
      "books/alpha-11111111/cache/answer.json",
      "books/alpha-11111111/meta.json",
      "books/alpha-11111111/source.pdf",
      "books/beta-22222222/meta.json",
    ]);
    expect((await to.read("books/alpha-11111111/source.pdf"))?.toString()).toBe("%PDF-alpha");
    expect((await to.read("books/beta-22222222/meta.json"))?.toString()).toContain('"already":true');
    expect(await keys(from)).toEqual(before);
    expect(await readFile(join(roots[0]!, "books/alpha-11111111/source.pdf"), "utf8")).toBe("%PDF-alpha");
  });

  it("should not copy a book that would take the other store past its limit", async () => {
    // beta's meta.json already there takes 37 bytes; alpha needs 10 + 2 + 15 + 23 = 50 more.
    const report = await copyBooks(from, to, { tempDir, limit: 37 + 49 });
    expect(report).toEqual({ copied: [], skipped: ["beta-22222222"], noRoom: ["alpha-11111111"] });
    expect(await keys(to)).toEqual(["books/beta-22222222/meta.json"]);
  });

  it("should clean up temp files even when putFile does not move them", async () => {
    // Create a store that copies instead of moving (like R2 does).
    const copying: ObjectStore = {
      ...to,
      putFile: async (key, path) => {
        await to.write(key, await readFile(path));
      },
    };

    const report = await copyBooks(from, copying, { tempDir, limit: null });

    expect(report).toEqual({ copied: ["alpha-11111111"], skipped: ["beta-22222222"], noRoom: [] });
    // Main assertion: tempDir should be empty because files were cleaned up.
    expect(await readdir(tempDir)).toEqual([]);
    // Verify the file was actually copied.
    expect((await copying.read("books/alpha-11111111/source.pdf"))?.toString()).toBe("%PDF-alpha");
  });
});
