import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QuestionNote } from "../../shared/types.ts";
import { NoteCard } from "./NoteCard.tsx";

describe("NoteCard", () => {
  it("should render a saved answer from the note without relying on the AI cache", () => {
    const note: QuestionNote = {
      id: "q1", chapterId: "c2", blockId: "c2-b1", quote: "What is known?", lang: "bn", mode: "simple",
      offset: 8, savedAnswer: "A durable answer chosen by the reader.",
    };
    const html = renderToStaticMarkup(
      <NoteCard note={note} bookId="book" latest onClose={() => {}} onSaveAnswer={() => {}} />,
    );
    expect(html).toContain("A durable answer chosen by the reader.");
    expect(html).toContain("Saved to notebook");
    expect(html).not.toContain("Reading the passage...");
  });
});
