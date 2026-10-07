import { describe, expect, it } from "vitest";
import type { BookDetail, Note } from "../../shared/types.ts";
import { exportNotebookMarkdown } from "./notebookExport.ts";

const book = {
  title: "The *Reader*",
  author: "A. <Writer>",
  chapters: [{ id: "c1", title: "Chapter #1", startPage: 1, endPage: 2, wordCount: 100 }],
} satisfies Pick<BookDetail, "title" | "author" | "chapters">;

const entries = [
  { id: "h1", chapterId: "c1", blockId: "b1", quote: "A *quoted* line\n# not a heading", lang: "bn", mode: "highlight", color: "yellow", offset: 4 },
  { id: "r1", chapterId: "c1", blockId: "b2", quote: "The source", lang: "bn", mode: "reflection", offset: 12, text: "My [thought](evil)\n<script>alert(1)</script>" },
  { id: "q1", chapterId: "c1", blockId: "b3", quote: "Why?", lang: "bn", mode: "simple", savedAnswer: "An AI answer\n## not a heading" },
  { id: "q2", chapterId: "c1", blockId: "b4", quote: "Unsaved?", lang: "bn", mode: "word" },
] as Note[];

describe("exportNotebookMarkdown", () => {
  it("exports only selected saved material with attribution and stable location", () => {
    const markdown = exportNotebookMarkdown({ book, entries, selectedIds: new Set(["h1", "r1", "q1", "q2"]) });
    expect(markdown).toContain("# The \\*Reader\\*");
    expect(markdown).toContain("A\\. &lt;Writer&gt;");
    expect(markdown).toContain("## Chapter \\#1");
    expect(markdown).toContain("### Highlight");
    expect(markdown).toContain("> A \\*quoted\\* line\n> \\# not a heading");
    expect(markdown).toContain("### Reader reflection");
    expect(markdown).toContain("My \\[thought\\]\\(evil\\)");
    expect(markdown).toContain("&lt;script&gt;alert\\(1\\)&lt;/script&gt;");
    expect(markdown).toContain("### Saved AI answer");
    expect(markdown).toContain("An AI answer\n\\#\\# not a heading");
    expect(markdown).toContain("chapter: c1; block: b1; offset: 4");
    expect(markdown).toContain("chapter: c1; block: b2; offset: 12");
    expect(markdown).toContain("chapter: c1; block: b3; offset: not recorded");
    expect(markdown).not.toContain("Unsaved?");
  });

  it("never leaks unselected entries or Markdown structure from their content", () => {
    const markdown = exportNotebookMarkdown({ book, entries, selectedIds: new Set(["r1"]) });
    expect(markdown).toContain("Reader reflection");
    expect(markdown).not.toContain("A \\*quoted\\* line");
    expect(markdown).not.toContain("Saved AI answer");
    expect(markdown).not.toContain("Unsaved?");
    expect(markdown).not.toContain("[thought](evil)");
    expect(markdown).not.toContain("<script>");
  });

  it("uses a recorded question offset when one is available", () => {
    const question = { ...entries[2], offset: 7 } as Note;
    const markdown = exportNotebookMarkdown({ book, entries: [question], selectedIds: new Set(["q1"]) });
    expect(markdown).toContain("chapter: c1; block: b3; offset: 7");
    expect(markdown).not.toContain("not recorded");
  });
});
