import { describe, expect, it } from "vitest";
import { parseRich } from "./RichText.tsx";
import { sentenceSpans, wordAt } from "./textRanges.ts";

const cut = (text: string, span: { start: number; end: number } | null) => span && text.slice(span.start, span.end);

describe("wordAt", () => {
  const text = "She didn't see the well-known attacker.";

  it("should return the whole word when the offset is inside it", () => {
    expect(cut(text, wordAt(text, text.indexOf("see") + 1))).toBe("see");
  });

  it("should keep a contraction together when tapped after the apostrophe", () => {
    expect(cut(text, wordAt(text, text.indexOf("'") + 1))).toBe("didn't");
  });

  it("should return the word when the offset is at its last letter boundary", () => {
    expect(cut(text, wordAt(text, text.indexOf("She") + 3))).toBe("She");
  });

  it("should return null when the offset is in punctuation between spaces", () => {
    const dashed = "one  -  two";
    expect(wordAt(dashed, dashed.indexOf("-") + 1)).toBeNull();
  });
});

describe("sentenceSpans", () => {
  it("should split sentences and trim the spaces between them", () => {
    const text = "Rapport comes first.  Then you lead! Does it work?";
    expect(sentenceSpans(text).map((span) => cut(text, span))).toEqual([
      "Rapport comes first.",
      "Then you lead!",
      "Does it work?",
    ]);
  });

  it("should return no sentences when the text is only whitespace", () => {
    expect(sentenceSpans("  \n ")).toEqual([]);
  });
});

describe("parseRich", () => {
  it("should group consecutive list lines and keep paragraphs separate", () => {
    expect(parseRich("**Key ideas:**\n- first\n- second\n\nTry this today.")).toEqual([
      { type: "p", text: "**Key ideas:**" },
      { type: "ul", items: ["first", "second"] },
      { type: "p", text: "Try this today." },
    ]);
  });
});
