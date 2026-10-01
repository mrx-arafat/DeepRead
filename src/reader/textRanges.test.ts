import { describe, expect, it } from "vitest";
import { parseGlossaryEntry, parseSections } from "./RichText.tsx";
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

  it("should return the whole hyphenated term when tapped in either part or on the hyphen", () => {
    const term = "the name of 'sense-data' to the things";
    for (const offset of [term.indexOf("sense") + 1, term.indexOf("-"), term.indexOf("data") + 2]) {
      expect(cut(term, wordAt(term, offset))).toBe("sense-data");
    }
    expect(cut(text, wordAt(text, text.indexOf("known")))).toBe("well-known");
  });

  it("should not join words across a double hyphen or a dash", () => {
    const dashes = "colour--oblong and sense-data\u2014brown";
    expect(cut(dashes, wordAt(dashes, 1))).toBe("colour");
    expect(cut(dashes, wordAt(dashes, dashes.indexOf("brown") + 1))).toBe("brown");
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

describe("parseSections", () => {
  it("should split an answer into labelled parts and group list lines", () => {
    const answer = [
      "**In simple words:** They sent money in secret.",
      "",
      "**Hard words:**",
      "- minute - very small",
      "- remitted - sent",
    ].join("\n");
    expect(parseSections(answer)).toEqual([
      { label: "In simple words", blocks: [{ type: "p", text: "They sent money in secret." }] },
      { label: "Hard words", blocks: [{ type: "ul", items: ["minute - very small", "remitted - sent"] }] },
    ]);
  });

  it("should keep text without any label as one unlabelled part", () => {
    expect(parseSections("A plain answer.\nSecond line.")).toEqual([
      {
        label: null,
        blocks: [
          { type: "p", text: "A plain answer." },
          { type: "p", text: "Second line." },
        ],
      },
    ]);
  });

  it("should not treat a sentence that starts with a bold word as a label", () => {
    expect(parseSections("**Rapport** means trust.")).toEqual([
      { label: null, blocks: [{ type: "p", text: "**Rapport** means trust." }] },
    ]);
  });

  it("should show a label that is still streaming in as a label", () => {
    expect(parseSections("**In simple words:** Done.\n**Deeper mea")).toEqual([
      { label: "In simple words", blocks: [{ type: "p", text: "Done." }] },
      { label: "Deeper mea", blocks: [] },
    ]);
  });
});

describe("parseGlossaryEntry", () => {
  it("should separate the term, its hint, the meaning and the native meaning", () => {
    expect(parseGlossaryEntry("minute (say my-NOOT) - extremely small (অতি সামান্য)")).toEqual({
      term: "minute",
      hint: "say my-NOOT",
      meaning: "extremely small",
      native: "অতি সামান্য",
    });
  });

  it("should keep an English bracket inside the meaning when there is no native meaning", () => {
    expect(parseGlossaryEntry("second-rate - not very good (of low quality)")).toEqual({
      term: "second-rate",
      hint: null,
      meaning: "not very good (of low quality)",
      native: null,
    });
  });

  it("should return null when the line has no term and meaning", () => {
    expect(parseGlossaryEntry("just some words")).toBeNull();
  });
});
