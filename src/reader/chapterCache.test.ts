import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chapter } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ChapterCache, cachedChapter, chapterKey, loadChapter } from "./chapterCache.ts";

vi.mock("../api.ts", () => ({ api: { getChapter: vi.fn() } }));

const chapter = (id: string, text: string): Chapter => ({ id, title: id, startPage: 1, endPage: 1, blocks: [{ id: `${id}-b1`, type: "paragraph", text, page: 1 }] });

describe("chapter cache", () => {
  it("should answer a kept chapter at once and evict the least recently read beyond the entry bound", () => {
    const cache = new ChapterCache(() => ({ entries: 2, characters: 100 }));
    const one = chapter("c1", "one");
    cache.set(chapterKey("book", "c1"), one);
    cache.set(chapterKey("book", "c2"), chapter("c2", "two"));
    // A synchronous hit: the same object, no promise.
    expect(cache.get(chapterKey("book", "c1"))).toBe(one);
    cache.set(chapterKey("book", "c3"), chapter("c3", "three"));
    expect(cache.has(chapterKey("book", "c2"))).toBe(false);
    expect(cache.has(chapterKey("book", "c1"))).toBe(true);
    expect(cache.has(chapterKey("other", "c1"))).toBe(false);
  });

  it("should bound the characters kept, count a replaced chapter once and never keep one over the budget", () => {
    const cache = new ChapterCache(() => ({ entries: 40, characters: 10 }));
    cache.set(chapterKey("book", "c1"), chapter("c1", "12345"));
    cache.set(chapterKey("book", "c2"), chapter("c2", "67890"));
    cache.set(chapterKey("book", "c1"), chapter("c1", "123"));
    cache.set(chapterKey("book", "c3"), chapter("c3", "abc"));
    expect(cache.has(chapterKey("book", "c2"))).toBe(false);
    expect(cache.get(chapterKey("book", "c1"))?.blocks[0]?.text).toBe("123");
    expect(cache.has(chapterKey("book", "c3"))).toBe(true);
    cache.set(chapterKey("book", "huge"), chapter("huge", "x".repeat(11)));
    expect(cache.has(chapterKey("book", "huge"))).toBe(false);
    expect(cache.has(chapterKey("book", "c1"))).toBe(true);
  });

  it("should read the bounds afresh on every write, so a tier change applies without a restart", () => {
    let entries = 3;
    const cache = new ChapterCache(() => ({ entries, characters: 1000 }));
    for (const id of ["c1", "c2", "c3"]) cache.set(chapterKey("book", id), chapter(id, "text"));
    expect(cache.has(chapterKey("book", "c1"))).toBe(true);
    entries = 1;
    cache.set(chapterKey("book", "c4"), chapter("c4", "text"));
    expect(cache.has(chapterKey("book", "c1"))).toBe(false);
    expect(cache.has(chapterKey("book", "c3"))).toBe(false);
    expect(cache.has(chapterKey("book", "c4"))).toBe(true);
  });
});

describe("loadChapter", () => {
  const getChapter = vi.mocked(api.getChapter);
  beforeEach(() => {
    getChapter.mockReset();
  });

  it("should share one request between a look-ahead and the mount that follows, then answer from the cache at once", async () => {
    let settle!: (chapter: Chapter) => void;
    getChapter.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const lookAhead = new AbortController();
    const mount = new AbortController();
    const first = loadChapter("book", "shared", lookAhead.signal);
    const second = loadChapter("book", "shared", mount.signal);
    expect(getChapter).toHaveBeenCalledTimes(1);
    // The look-ahead stops waiting: the mount still needs the request, so it goes on.
    lookAhead.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(getChapter.mock.calls[0]![2]!.aborted).toBe(false);
    const answer = chapter("shared", "text");
    settle(answer);
    expect(await second).toBe(answer);
    expect(cachedChapter("book", "shared")).toBe(answer);
    expect(await loadChapter("book", "shared")).toBe(answer);
    expect(getChapter).toHaveBeenCalledTimes(1);
  });

  it("should give the request up when the last reader stops waiting, and ask again on the next read", async () => {
    getChapter.mockReturnValue(new Promise(() => {}));
    const only = new AbortController();
    const waited = loadChapter("book", "dropped", only.signal);
    only.abort();
    await expect(waited).rejects.toMatchObject({ name: "AbortError" });
    expect(getChapter.mock.calls[0]![2]!.aborted).toBe(true);
    void loadChapter("book", "dropped", new AbortController().signal).catch(() => {});
    expect(getChapter).toHaveBeenCalledTimes(2);
  });
});
