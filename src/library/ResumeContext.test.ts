import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeContextResponse } from "../../shared/types.ts";
import { api, ApiFailure } from "../api.ts";
import type { StartedBook } from "./bookText.ts";
import { loadResumeContext } from "./ResumeContext.tsx";

const book: StartedBook = {
  id: "book", title: "Book", author: null, pageCount: 1, chapterCount: 1, wordCount: 10, hasCover: false, readingStatus: "reading",
  addedAt: "2026-10-07T00:00:00Z",
  progress: { chapterId: "c1", chapterTitle: "One", blockId: "b1", offset: 3, updatedAt: "2026-10-07T00:00:00Z", percent: 10 },
};
const content: ResumeContextResponse = {
  chapter: { id: "c1", title: "One" }, context: { state: "ready", excerpt: "Before", highlight: null }, noteError: null,
};
afterEach(() => vi.restoreAllMocks());

describe("loadResumeContext", () => {
  it("requests one compact reminder for the exact shelf position and forwards cancellation", async () => {
    const request = vi.spyOn(api, "getResumeContext").mockResolvedValue(content);
    const chapter = vi.spyOn(api, "getChapter");
    const notes = vi.spyOn(api, "getNotes");
    const signal = new AbortController().signal;
    await expect(loadResumeContext(book, signal)).resolves.toEqual(content);
    expect(request).toHaveBeenCalledExactlyOnceWith(book.id, book.progress, signal);
    expect(chapter).not.toHaveBeenCalled();
    expect(notes).not.toHaveBeenCalled();
  });

  it("rejects access loss instead of revealing the reminder", async () => {
    for (const status of [401, 403, 404]) {
      const error = new ApiFailure("book_not_found", "This book is no longer available.", status);
      vi.spyOn(api, "getResumeContext").mockRejectedValue(error);
      await expect(loadResumeContext(book, new AbortController().signal)).rejects.toBe(error);
    }
  });

  it("retains the bounded passage and retry state when only highlight storage failed", async () => {
    const partial = { ...content, noteError: "Your highlights could not be loaded." };
    vi.spyOn(api, "getResumeContext").mockResolvedValue(partial);
    await expect(loadResumeContext(book, new AbortController().signal)).resolves.toEqual(partial);
  });

  it("encodes saved anchors, defaults old offsets to zero and cancels the compact request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(content)));
    const signal = new AbortController().signal;
    await api.getResumeContext("book", { ...book.progress, chapterId: "c&1", blockId: "b/1", offset: undefined }, signal);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/books/book/resume?chapterId=c%261&blockId=b%2F1&offset=0", { signal });
  });
});
