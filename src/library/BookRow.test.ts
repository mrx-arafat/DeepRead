import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BookSummary } from "../../shared/types.ts";
import { BookRow } from "./BookRow.tsx";

vi.mock("wouter", async () => {
  const { createElement } = await import("react");
  return { Link: ({ href, children }: { href: string; children: React.ReactNode }) => createElement("a", { href }, children) };
});

const book: BookSummary = {
  id: "book-one",
  title: "Book One",
  author: null,
  pageCount: 10,
  chapterCount: 1,
  wordCount: 1000,
  addedAt: "2026-01-01T00:00:00.000Z",
  progress: null,
  readingStatus: "saved",
  hasCover: false,
};

function render(pending: string | null, status: BookSummary["readingStatus"]): string {
  return renderToStaticMarkup(createElement(BookRow, {
    book: { ...book, readingStatus: status },
    mode: "view",
    pending,
    deleteError: null,
    focusLink: false,
    focusMenu: false,
    readerId: null,
    onMode: () => {},
    onPin: () => {},
    onStatus: () => {},
    onSave: async () => {},
    onRemove: async () => {},
  }));
}

describe("BookRow reading status", () => {
  it("should expose the manual status alongside the existing book actions", () => {
    const html = render(null, "saved");
    expect(html).toContain("Reading status for Book One");
    expect(html).toContain('<option value="saved" selected="">Saved for later</option>');
    expect(html).toContain("More actions for Book One");
  });

  it("should prevent another change while a book write is pending", () => {
    const html = render("book-one", "finished");
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(html).toContain('<option value="finished" selected="">Finished</option>');
  });
});
