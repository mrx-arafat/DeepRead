import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chapter } from "../../shared/types.ts";
import { api, ApiFailure } from "../api.ts";
import type { StartedBook } from "./bookText.ts";
import { loadResumeContext } from "./ResumeContext.tsx";

const book: StartedBook = {
  id: "book", title: "Book", author: null, pageCount: 1, chapterCount: 1, wordCount: 10, hasCover: false, readingStatus: "reading",
  addedAt: "2026-10-07T00:00:00Z",
  progress: { chapterId: "c1", chapterTitle: "One", blockId: "b1", offset: 3, updatedAt: "2026-10-07T00:00:00Z", percent: 10 },
};
const chapter: Chapter = { id: "c1", title: "One", startPage: 1, endPage: 1, blocks: [] };
afterEach(() => vi.restoreAllMocks());

describe("loadResumeContext", () => {
  it("should reject access loss even when the chapter arrived before the notes request was refused", async () => {
    vi.spyOn(api, "getChapter").mockResolvedValue(chapter);
    for (const status of [401, 403, 404]) {
      const error = new ApiFailure("book_not_found", "This book is no longer available.", status);
      vi.spyOn(api, "getNotes").mockRejectedValue(error);
      await expect(loadResumeContext(book, new AbortController().signal)).rejects.toBe(error);
    }
  });

  it("should retain authorized chapter text with a retry state when only the highlights connection failed", async () => {
    vi.spyOn(api, "getChapter").mockResolvedValue(chapter);
    vi.spyOn(api, "getNotes").mockRejectedValue(new ApiFailure("unreachable", "Connection lost", 0));
    await expect(loadResumeContext(book, new AbortController().signal)).resolves.toEqual({ chapter, notes: [], noteError: "Your highlights could not be loaded." });
  });
});
