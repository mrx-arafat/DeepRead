import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookSummary, ReadingProgress, SessionInfo, StorageView } from "../../shared/types.ts";
import { latestRead } from "./bookText.ts";
import {
  addBook,
  dropBook,
  forgetShelves,
  patchBook,
  progressFiler,
  readerKey,
  readShelf,
  rememberBooks,
  rememberStorage,
  setReader,
  watchShelves,
} from "./shelfCache.ts";

function book(id: string, progress: ReadingProgress | null = null): BookSummary {
  return {
    id,
    title: `Book ${id}`,
    author: null,
    pageCount: 100,
    chapterCount: 10,
    wordCount: 36_000,
    addedAt: "2026-01-01T00:00:00.000Z",
    progress,
    hasCover: false,
  };
}

function place(updatedAt: string, percent: number): ReadingProgress {
  return { chapterId: "c2", blockId: "c2-b4", offset: 0, updatedAt, chapterTitle: "Two", percent };
}

const used: StorageView = { used: 1_000, limit: null, where: "local" };

beforeEach(() => {
  forgetShelves();
});

describe("shelf cache", () => {
  it("should keep each reader's books and storage apart from everyone else's", () => {
    rememberBooks("ann", [book("a")]);
    rememberStorage("ann", used);
    rememberBooks("bob", [book("b")]);

    expect(readShelf("ann")).toEqual({ books: [book("a")], storage: used });
    expect(readShelf("bob")).toEqual({ books: [book("b")], storage: null });
    expect(readShelf("cy")).toEqual({ books: null, storage: null });
  });

  it("should forget every reader's shelf on sign out", () => {
    rememberBooks("ann", [book("a")]);
    rememberBooks("bob", [book("b")]);

    forgetShelves();

    expect(readShelf("ann").books).toBeNull();
    expect(readShelf("bob").books).toBeNull();
  });

  it("should change one book, drop another and put a new one first, for that reader only", () => {
    rememberBooks("ann", [book("a"), book("b"), book("c")]);
    rememberBooks("bob", [book("a")]);

    patchBook("ann", "b", { title: "Renamed", author: "Someone" });
    dropBook("ann", "c");
    addBook("ann", book("d"));

    expect(readShelf("ann").books?.map((each) => [each.id, each.title, each.author])).toEqual([
      ["d", "Book d", null],
      ["a", "Book a", null],
      ["b", "Renamed", "Someone"],
    ]);
    expect(readShelf("bob").books).toEqual([book("a")]);
  });

  it("should not invent a shelf when there is nothing cached to change", () => {
    patchBook("ann", "a", { title: "Renamed" });
    dropBook("ann", "a");
    addBook("ann", book("a"));

    expect(readShelf("ann").books).toBeNull();
  });

  it("should move the Continue card to the book whose place was saved", () => {
    const read = book("a", place("2026-05-01T00:00:00.000Z", 10));
    rememberBooks("ann", [read, book("b")]);
    expect(latestRead(readShelf("ann").books ?? [])?.id).toBe("a");

    patchBook("ann", "b", { progress: place("2026-05-02T00:00:00.000Z", 35) });

    expect(latestRead(readShelf("ann").books ?? [])).toMatchObject({ id: "b", progress: { percent: 35 } });
  });

  it("should file a saved place on the shelf of whoever was reading when the save began", () => {
    rememberBooks("ann", [book("a")]);
    rememberBooks("bob", [book("a")]);
    setReader("ann");
    const file = progressFiler();

    // Someone else has signed in by the time the answer comes back.
    setReader("bob");
    file("a", place("2026-05-02T00:00:00.000Z", 35));

    expect(readShelf("ann").books?.[0]?.progress?.percent).toBe(35);
    expect(readShelf("bob").books?.[0]?.progress).toBeNull();
  });

  it("should tell a watcher when a shelf changes, until it stops watching", () => {
    const changed = vi.fn();
    const stop = watchShelves(changed);

    rememberBooks("ann", [book("a")]);
    expect(changed).toHaveBeenCalledTimes(1);

    stop();
    rememberBooks("ann", [book("b")]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("readerKey", () => {
  const profile = { id: "p1", name: "Pat", avatar: { preset: "smile-blue", photo: null }, admin: false, badge: null } as const;

  it("should be the profile being read as, and a fixed key when DeepRead has no profiles", () => {
    const signedIn: SessionInfo = {
      mode: "profiles",
      session: { profile, admin: true, impersonatedBy: { ...profile, id: "boss", admin: true }, expiresAt: "2026-06-01T00:00:00.000Z" },
    };

    expect(readerKey(signedIn)).toBe("p1");
    expect(readerKey({ mode: "single" })).toBe("single");
  });
});
