import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedBook } from "../shared/types.ts";
import { createLibrary } from "./library.ts";
import { createLocalStore } from "./storage.ts";

const fixture = (text = "Original passage."): ParsedBook => ({
  title: "Loading", author: null, pageCount: 1, warnings: [],
  chapters: [{ id: "c1", title: "One", startPage: 1, endPage: 1,
    blocks: [{ id: "c1-b1", type: "paragraph", page: 1, text }] }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ready, failed) => { resolve = ready; reject = failed; });
  return { promise, resolve, reject };
}

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "deepread-loading-"));
  folders.push(dir);
  const raw = createLocalStore(dir);
  const initial = createLibrary(dir, { store: raw });
  const uploadPath = await initial.newUploadPath("Loading");
  await writeFile(uploadPath, "%PDF-fixture");
  const { id } = await initial.add({ uploadPath, sha256: "a".repeat(64), parsed: fixture(), cover: null });
  await initial.close();
  const started = deferred<Buffer | null>();
  const release = deferred<Buffer | null>();
  let reads = 0;
  const store = { ...raw, async read(key: string) {
    const data = await raw.read(key);
    if (key === `books/${id}/book.json` && ++reads === 1) {
      started.resolve(data);
      return release.promise;
    }
    return data;
  } };
  return { id, dir, library: createLibrary(dir, { store }), started, release, reads: () => reads };
}

describe("concurrent parsed book loading", () => {
  it("shares one cold read between opening details and chapter text", async () => {
    const state = await setup();
    const opening = Promise.all([state.library.detail(state.id), state.library.book(state.id)]);
    const data = await state.started.promise;
    state.release.resolve(data);
    const [detail, book] = await opening;
    expect(detail?.chapters[0]?.id).toBe("c1");
    expect(book).toEqual(fixture());
    expect(state.reads()).toBe(1);
    expect(await state.library.book(state.id)).toEqual(book);
    expect(state.reads()).toBe(1);
  });

  it("retries a failed shared read rather than retaining its rejection", async () => {
    const state = await setup();
    const opening = Promise.allSettled([state.library.detail(state.id), state.library.book(state.id)]);
    await state.started.promise;
    state.release.reject(new Error("Storage temporarily unavailable"));
    expect((await opening).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(state.reads()).toBe(1);
    expect(await state.library.book(state.id)).toEqual(fixture());
    expect(state.reads()).toBe(2);
  });

  it("does not publish a stale read after deletion and reimport of the same ID", async () => {
    const state = await setup();
    const old = state.library.book(state.id);
    const oldData = await state.started.promise;
    expect(await state.library.remove(state.id)).toBe(true);
    const uploadPath = await state.library.newUploadPath("Loading");
    await writeFile(uploadPath, "%PDF-fixture");
    const added = await state.library.add({ uploadPath, sha256: "a".repeat(64), parsed: fixture("Replacement passage."), cover: null });
    expect(added.id).toBe(state.id);
    expect(await state.library.book(state.id)).toEqual(fixture("Replacement passage."));
    state.release.resolve(oldData);
    expect(await old).toBeNull();
    expect(await state.library.book(state.id)).toEqual(fixture("Replacement passage."));
    expect(state.reads()).toBe(2);
  });
});
