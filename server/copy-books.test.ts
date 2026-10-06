import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyBooks, copyLibrary } from "./copy-books.ts";
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

describe("copyLibrary", () => {
  let roots: string[];
  let from: ObjectStore;
  let to: ObjectStore;
  let tempDir: string;

  const PROFILES = JSON.stringify({
    profiles: [
      { id: "admin-aaaaaa", name: "Admin" },
      { id: "mina-bbbbbb", name: "Mina" },
    ],
  });

  beforeEach(async () => {
    roots = await Promise.all(["from", "to", "temp"].map((name) => mkdtemp(join(tmpdir(), `deepread-library-${name}-`))));
    [from, to] = roots.map((root) => createLocalStore(root)) as [ObjectStore, ObjectStore];
    tempDir = roots[2]!;
    await from.write("books/alpha-11111111/source.pdf", "%PDF-alpha");
    await from.write("books/alpha-11111111/meta.json", '{"id":"alpha-11111111"}');
    await from.write("profiles.json", PROFILES);
    await from.write("profiles/admin-aaaaaa/books/beta-22222222/source.pdf", "%PDF-beta");
    await from.write("profiles/admin-aaaaaa/books/beta-22222222/meta.json", '{"id":"beta-22222222"}');
    await from.write("profiles/mina-bbbbbb/books/gamma-33333333/source.pdf", "%PDF-gamma");
    await from.write("profiles/mina-bbbbbb/books/gamma-33333333/cache/answer.json", '{"text":"kept"}');
    await from.write("profiles/mina-bbbbbb/books/gamma-33333333/meta.json", '{"id":"gamma-33333333"}');
    await from.write("profiles/mina-bbbbbb/avatar.webp", "webp-bytes");
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const keys = async (store: ObjectStore) => (await store.list("")).map((object) => object.key).sort();

  it("should copy every profile with its books and photo, profiles.json last, and leave the source alone", async () => {
    const before = await keys(from);
    // A store that notes the order in which objects land, whichever way they are put there.
    const order: string[] = [];
    const recording: ObjectStore = {
      ...to,
      putFile: async (key, path) => {
        order.push(key);
        await to.putFile(key, path);
      },
      write: async (key, data) => {
        order.push(key);
        await to.write(key, data);
      },
    };
    const seen: Array<[string, string | undefined]> = [];

    const report = await copyLibrary(from, recording, {
      tempDir,
      limit: null,
      onBook: (id, _outcome, _bytes, profile) => seen.push([id, profile?.id]),
    });

    expect(report).toEqual({
      books: { copied: ["alpha-11111111"], skipped: [], noRoom: [] },
      profiles: {
        outcome: "copied",
        list: [
          { id: "admin-aaaaaa", name: "Admin", books: { copied: ["beta-22222222"], skipped: [], noRoom: [] }, photo: false },
          { id: "mina-bbbbbb", name: "Mina", books: { copied: ["gamma-33333333"], skipped: [], noRoom: [] }, photo: true },
        ],
      },
    });
    expect(seen).toEqual([
      ["alpha-11111111", undefined],
      ["beta-22222222", "admin-aaaaaa"],
      ["gamma-33333333", "mina-bbbbbb"],
    ]);
    expect(await keys(to)).toEqual(before);
    expect((await to.read("profiles/mina-bbbbbb/avatar.webp"))?.toString()).toBe("webp-bytes");
    expect((await to.read("profiles/mina-bbbbbb/books/gamma-33333333/cache/answer.json"))?.toString()).toBe('{"text":"kept"}');
    expect((await to.read("profiles.json"))?.toString()).toBe(PROFILES);
    // Nothing the target lists may be missing its books: profiles.json is the final object, and the only one of its name.
    expect(order.at(-1)).toBe("profiles.json");
    expect(order.filter((key) => key === "profiles.json")).toHaveLength(1);
    expect(order.indexOf("profiles/mina-bbbbbb/avatar.webp")).toBeLessThan(order.indexOf("profiles.json"));
    expect(await keys(from)).toEqual(before);
    expect(await readFile(join(roots[0]!, "profiles/mina-bbbbbb/avatar.webp"), "utf8")).toBe("webp-bytes");
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("should copy the root books but no profiles when the target already has its own profiles.json", async () => {
    const own = JSON.stringify({ profiles: [{ id: "zed-cccccc", name: "Zed" }] });
    await to.write("profiles.json", own);
    await to.write("profiles/zed-cccccc/books/delta-44444444/meta.json", '{"id":"delta-44444444"}');
    const before = await keys(from);

    const report = await copyLibrary(from, to, { tempDir, limit: null });

    expect(report).toEqual({ books: { copied: ["alpha-11111111"], skipped: [], noRoom: [] }, profiles: { outcome: "refused", list: [] } });
    expect(await keys(to)).toEqual([
      "books/alpha-11111111/meta.json",
      "books/alpha-11111111/source.pdf",
      "profiles.json",
      "profiles/zed-cccccc/books/delta-44444444/meta.json",
    ]);
    expect((await to.read("profiles.json"))?.toString()).toBe(own);
    expect(await keys(from)).toEqual(before);
  });

  it("should count everything copied so far against the limit, and not list profiles whose books are missing", async () => {
    // Every book here takes 6 bytes: source.pdf "aaaa" and meta.json "{}".
    await from.removeAll("books/");
    await from.removeAll("profiles/");
    await from.write("books/one-11111111/source.pdf", "aaaa");
    await from.write("books/one-11111111/meta.json", "{}");
    await from.write("profiles/admin-aaaaaa/books/two-22222222/source.pdf", "aaaa");
    await from.write("profiles/admin-aaaaaa/books/two-22222222/meta.json", "{}");
    await from.write("profiles/mina-bbbbbb/books/three-33333333/source.pdf", "aaaa");
    await from.write("profiles/mina-bbbbbb/books/three-33333333/meta.json", "{}");

    const report = await copyLibrary(from, to, { tempDir, limit: 12 });

    expect(report.books).toEqual({ copied: ["one-11111111"], skipped: [], noRoom: [] });
    expect(report.profiles.outcome).toBe("unfinished");
    expect(report.profiles.list.map((profile) => profile.books)).toEqual([
      { copied: ["two-22222222"], skipped: [], noRoom: [] },
      { copied: [], skipped: [], noRoom: ["three-33333333"] },
    ]);
    expect(await to.read("profiles.json")).toBeNull();
    expect(await readdir(tempDir)).toEqual([]);
  });
});
