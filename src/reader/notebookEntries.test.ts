import { describe, expect, it } from "vitest";
import type { BookDetail, Note } from "../../shared/types.ts";
import { entryKind, entryLabel, entryPreview, groupByChapter, keptEntries } from "./notebookEntries.ts";

const chapters: BookDetail["chapters"] = [
  { id: "c1", title: "Preface", startPage: 1, endPage: 1, wordCount: 10 },
  { id: "c2", title: "Appearance and Reality", startPage: 2, endPage: 9, wordCount: 900 },
];

const answer = "**Picture this:** Imagine you *cook* for guests.\n\n**So here:** Russell is the **cook**.";
const notes: Note[] = [
  { id: "late", chapterId: "c2", blockId: "c2-b10", quote: "Tenth paragraph", lang: "bn", mode: "highlight", color: "blue", offset: 0 },
  { id: "answer", chapterId: "c2", blockId: "c2-b2", quote: "Second paragraph, later words", lang: "bn", mode: "example", offset: 40, savedAnswer: answer },
  { id: "early", chapterId: "c2", blockId: "c2-b2", quote: "Second paragraph", lang: "bn", mode: "reflection", offset: 3, text: "My  own\nthought" },
  { id: "unsaved", chapterId: "c1", blockId: "c1-b1", quote: "Asked but not kept", lang: "bn", mode: "simple" },
  { id: "preface", chapterId: "c1", blockId: "c1-b1", quote: "In the following pages", lang: "bn", mode: "native", offset: 0, savedAnswer: "এটি একটি উত্তর।" },
];

describe("notebook entries", () => {
  it("should keep only what the reader chose to keep, in book order and then in the order of the text", () => {
    const kept = keptEntries(notes, chapters);
    expect(kept.map((note) => note.id)).toEqual(["preface", "early", "answer", "late"]);
    const groups = groupByChapter(kept, chapters);
    expect(groups.map((group) => [group.title, group.entries.map((note) => note.id)])).toEqual([
      ["Preface", ["preface"]],
      ["Appearance and Reality", ["early", "answer", "late"]],
    ]);
  });

  it("should give each entry a kind, a name, and a one-line preview without the AI's marks", () => {
    const byId = (id: string) => notes.find((note) => note.id === id)!;
    expect(["late", "answer", "early"].map((id) => entryKind(byId(id)))).toEqual(["highlight", "answer", "reflection"]);
    expect(entryLabel(byId("answer"))).toBe("Example");
    expect(entryLabel(byId("preface"))).toBe("In Bangla");
    expect(entryLabel(byId("late"))).toBe("Highlight");
    expect(entryPreview(byId("answer"))).toBe("Imagine you cook for guests.");
    expect(entryPreview(byId("early"))).toBe("My own thought");
    expect(entryPreview(byId("late"))).toBe("");
  });
});
