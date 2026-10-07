import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BookDetail, Note } from "../../shared/types.ts";
import { Notebook } from "./Notebook.tsx";

const book = {
  id: "book", title: "A Reader's Book", author: null, pageCount: 2, chapterCount: 1, wordCount: 12,
  addedAt: "2026-10-07T00:00:00Z", progress: null, readingStatus: "reading", hasCover: false,
  chapters: [{ id: "c1", title: "First chapter", startPage: 1, endPage: 2, wordCount: 12 }], warnings: [],
} satisfies BookDetail;

const entries: Note[] = [
  { id: "h1", chapterId: "c1", blockId: "b1", quote: "Marked text", lang: "bn", mode: "highlight", color: "yellow", offset: 2 },
  { id: "r1", chapterId: "c1", blockId: "b2", quote: "Remember this", lang: "bn", mode: "reflection", offset: 3, text: "My thought" },
  { id: "q1", chapterId: "c1", blockId: "b3", quote: "Useful answer", lang: "bn", mode: "word", savedAnswer: "The answer" },
  { id: "q2", chapterId: "c1", blockId: "b4", quote: "Unsaved answer", lang: "bn", mode: "word" },
];

const actions = { saveReflection: () => {}, remove: () => {}, restore: () => {}, openSource: async () => true, retry: () => {}, discard: () => {} };

describe("Notebook", () => {
  it("shows only durable reader entries with selection, source actions, and sync state", () => {
    const html = renderToStaticMarkup(createElement(Notebook, { book, entries, initialDraft: null, removed: null,
      syncState: { phase: "saved", pending: 0, durable: true }, actions, onClose: () => {} }));
    expect(html).toContain("Marked text");
    expect(html).toContain("My thought");
    expect(html).toContain("The answer");
    expect(html).not.toContain("Unsaved answer");
    expect(html).toContain("Select reflection from First chapter");
    expect(html).toContain("Open passage");
    expect(html).toContain("Notes saved");
  });

  it("offers the reflection editor for a selected passage", () => {
    const html = renderToStaticMarkup(createElement(Notebook, { book, entries: [],
      initialDraft: { chapterId: "c1", blockId: "b1", quote: "Selected line", offset: 0 }, removed: null,
      syncState: { phase: "saving", pending: 0, durable: true }, actions, onClose: () => {} }));
    expect(html).toContain("Selected line");
    expect(html).toContain("Your reflection");
    expect(html).toContain("Save reflection");
  });
});
