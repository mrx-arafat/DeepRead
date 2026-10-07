import { describe, expect, it } from "vitest";
import type { BookSummary, ReadingStatus } from "../../shared/types.ts";
import { CLOTH_COUNT, clothFor, coverTitleSize, filterBooks, latestRead, readingNote, shortTitle, splitPinned } from "./bookText.ts";

/** 36 000 words: exactly 200 minutes of reading at 180 words a minute. */
function book(title: string, progress?: { percent: number; updatedAt: string }, readingStatus: ReadingStatus = "reading"): BookSummary {
  return {
    id: title,
    title,
    author: null,
    pageCount: 100,
    chapterCount: 10,
    wordCount: 36_000,
    addedAt: "2026-01-01T00:00:00.000Z",
    progress: progress ? { chapterId: "c1", blockId: "c1-b1", chapterTitle: "One", ...progress } : null,
    hasCover: false,
    readingStatus,
  };
}

describe("shortTitle", () => {
  it("should keep a title that fits as it is", () => {
    expect(shortTitle("The Problems of Philosophy", 60)).toBe("The Problems of Philosophy");
  });

  it("should cut a long title between words when it can, and say it was cut", () => {
    expect(shortTitle("A Complete Introduction to Knowledge", 25)).toBe("A Complete Introduction...");
    expect(shortTitle("abcde fghij", 5)).toBe("abcde...");
  });

  it("should cut inside a word when the title has no space to cut at", () => {
    expect(shortTitle("Supercalifragilistic", 5)).toBe("Super...");
  });

  it("should never cut inside a letter the reader sees as one when the title has joined characters", () => {
    const family = "👨‍👩‍👧";
    expect(shortTitle(`aaaaa${family}${family}${family}`, 6)).toBe(`aaaaa${family}...`);
  });
});

describe("clothFor", () => {
  it("should bind the same title in the same cloth whatever its case or spacing", () => {
    expect(clothFor("The Problems of Philosophy")).toBe(clothFor("  the  PROBLEMS of   philosophy "));
  });

  it("should stay within the cloths and use most of them across different titles", () => {
    const titles = Array.from({ length: 60 }, (_, at) => `Book number ${at} of the shelf`);
    const used = new Set(titles.map(clothFor));
    expect([...used].every((cloth) => Number.isInteger(cloth) && cloth >= 1 && cloth <= CLOTH_COUNT)).toBe(true);
    expect(used.size).toBeGreaterThanOrEqual(8);
  });
});

describe("coverTitleSize", () => {
  it("should stamp a title smaller the longer it is, and smaller still when one word is long", () => {
    expect(coverTitleSize("Walden")).toBe(1);
    expect(coverTitleSize("Pride and Prejudice")).toBe(2);
    expect(coverTitleSize("Meditations")).toBe(2);
    expect(coverTitleSize("The Problems of Philosophy: An Introduction to Knowledge and Matter")).toBe(4);
  });
});

describe("readingNote", () => {
  it("should call an unopened book new and say how long it takes to read", () => {
    expect(readingNote(book("A"))).toEqual({ state: "reading", lead: "New", detail: "3 h 15 min to read", percent: 0 });
  });

  it("should give the percentage and the time left for a book part way through", () => {
    // 200 minutes in all, a quarter read: 150 left.
    const note = readingNote(book("A", { percent: 25, updatedAt: "2026-02-01T00:00:00.000Z" }));
    expect(note).toEqual({ state: "reading", lead: "25%", detail: "2 h 30 min left", percent: 25 });
  });

  it("should not print 0% for a book that was opened but not read", () => {
    expect(readingNote(book("A", { percent: 0, updatedAt: "2026-02-01T00:00:00.000Z" })).lead).toBe("Just started");
  });

  it("should count minutes under an hour and whole hours for a long book", () => {
    expect(readingNote(book("A", { percent: 80, updatedAt: "2026-02-01T00:00:00.000Z" })).detail).toBe("40 min left");
    expect(readingNote({ ...book("A"), wordCount: 180 * 60 * 20 }).detail).toBe("20 h to read");
  });

  it("should use the reader's manual status rather than infer finished from position", () => {
    const place = { percent: 25, updatedAt: "2026-02-01T00:00:00.000Z" };
    expect(readingNote(book("A", place, "saved")).lead).toBe("Saved for later");
    expect(readingNote(book("A", place, "finished")).lead).toBe("Finished");
    expect(readingNote(book("A", { ...place, percent: 100 }, "reading")).lead).toBe("100%");
  });
});

describe("latestRead", () => {
  it("should offer the book opened most recently", () => {
    const books = [
      book("old", { percent: 40, updatedAt: "2026-02-01T10:00:00.000Z" }),
      book("recent", { percent: 5, updatedAt: "2026-03-01T10:00:00.000Z" }),
      book("unread"),
    ];
    expect(latestRead(books)?.title).toBe("recent");
  });

  it("should skip saved and finished books but still offer a reading book at the end", () => {
    const books = [
      book("done", { percent: 25, updatedAt: "2026-04-01T10:00:00.000Z" }, "finished"),
      book("later", { percent: 50, updatedAt: "2026-03-01T10:00:00.000Z" }, "saved"),
      book("reading", { percent: 100, updatedAt: "2026-02-01T10:00:00.000Z" }, "reading"),
    ];
    expect(latestRead(books)?.title).toBe("reading");
  });

  it("should offer nothing when no book has been opened", () => {
    expect(latestRead([book("a"), book("b")])).toBeNull();
  });
});

describe("splitPinned", () => {
  const pinned = (id: string, pinnedAt: string): BookSummary => ({ ...book(id), pinnedAt });

  it("should put the book pinned last first, break a tie by id, and leave the rest in the order they came in", () => {
    const shelf = [
      book("rest1"),
      pinned("x", "2026-03-01T10:00:00.000Z"),
      pinned("y", "2026-05-01T10:00:00.000Z"),
      book("rest2"),
      pinned("w", "2026-05-01T10:00:00.000Z"),
      pinned("z", "2026-04-01T10:00:00.000Z"),
    ];

    const split = splitPinned(shelf);

    expect(split.pinned.map((each) => each.id)).toEqual(["w", "y", "z", "x"]);
    expect(split.rest.map((each) => each.id)).toEqual(["rest1", "rest2"]);
  });

  it("should leave the shelf as it is when nothing is pinned", () => {
    expect(splitPinned([book("b"), book("a")])).toEqual({ pinned: [], rest: [book("b"), book("a")] });
  });
});

describe("filterBooks", () => {
  it("should match titles and authors without case or outside spaces changing results", () => {
    const books = [book("Meditations"), { ...book("Philosophy"), author: "Bertrand Russell" }];
    expect(filterBooks(books, "  MEDIT  ").map((each) => each.id)).toEqual(["Meditations"]);
    expect(filterBooks(books, "russell").map((each) => each.id)).toEqual(["Philosophy"]);
    expect(filterBooks(books, "unknown")).toEqual([]);
    expect(filterBooks(books, "  ")).toEqual(books);
  });

  it("should combine title search with the selected manual reading status", () => {
    const books = [book("Philosophy", undefined, "saved"), book("Philosophy II", undefined, "finished"), book("Literature", undefined, "reading")];
    expect(filterBooks(books, "philosophy", "saved").map((each) => each.id)).toEqual(["Philosophy"]);
    expect(filterBooks(books, "", "finished").map((each) => each.id)).toEqual(["Philosophy II"]);
    expect(filterBooks(books, "", "all")).toEqual(books);
  });
});
