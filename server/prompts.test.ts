// What the translating prompts ask for, and which of them carry the book's translator's notes.
import { describe, expect, it } from "vitest";
import { explainPrompt } from "./prompts.ts";
import type { PassageContext } from "./prompts.ts";

const NOTES = "Translator's notes for this book, to follow in every line:\nNames: Marlow = মার্লো (the narrator)";

const context = (change: Partial<PassageContext> = {}): PassageContext => ({
  bookTitle: "Heart of Darkness",
  chapterTitle: "I",
  passage: '[The reader is on this paragraph]\n"Come in," said Marlow.',
  selection: '"Come in," said Marlow.',
  language: "Bangla",
  ...change,
});

describe("explainPrompt", () => {
  it("should ask a selection's Bangla for meaning in context, চলিত and a respect level, with the notes before the task", () => {
    const { user } = explainPrompt("native", context({ style: NOTES }));
    expect(user).toContain("Translate the meaning in this context, not the words one by one.");
    expect(user).toContain("in চলিত, never সাধু");
    expect(user).toContain("(আপনি, তুমি or তুই, with the verb forms that go with it)");
    expect(user).toContain("follow them exactly");
    expect(user.indexOf(NOTES)).toBeGreaterThan(user.indexOf("Chapter: I"));
    expect(user.indexOf(NOTES)).toBeLessThan(user.indexOf("The reader selected"));
  });

  it("should give the notes to a tapped word and a translation only, and leave every other prompt as it was", () => {
    expect(explainPrompt("word", context({ style: NOTES })).user).toContain("write exactly that");
    expect(explainPrompt("word", context({ style: NOTES })).user).toContain(NOTES);
    for (const mode of ["simple", "example", "deep"] as const) expect(explainPrompt(mode, context({ style: NOTES })).user).not.toContain(NOTES);
    // With no notes the word prompt is the one cached answers were made from.
    expect(explainPrompt("word", context({ style: "" })).user).toBe(explainPrompt("word", context()).user);
    expect(explainPrompt("native", context()).user).not.toContain("follow them exactly");
  });
});
