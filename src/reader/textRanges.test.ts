import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseGlossaryEntry, parseSections, RichText } from "./RichText.tsx";
import { sentenceSpans, stepWord, termSpan, wordAt } from "./textRanges.ts";

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

  it("should return a fixed foreign phrase whole when any of its words is tapped", () => {
    const latin = "whatever knowledge was A priori must be 'analytic', a view per se";
    expect(cut(latin, wordAt(latin, latin.indexOf("priori") + 2))).toBe("A priori");
    expect(cut(latin, wordAt(latin, latin.indexOf("A priori")))).toBe("A priori");
    expect(cut(latin, wordAt(latin, latin.indexOf("se") + 1))).toBe("per se");
    expect(cut(latin, wordAt(latin, latin.indexOf("a view")))).toBe("a");
  });

  it("should not join words across a double hyphen or a dash", () => {
    const dashes = "colour--oblong and sense-data\u2014brown";
    expect(cut(dashes, wordAt(dashes, 1))).toBe("colour");
    expect(cut(dashes, wordAt(dashes, dashes.indexOf("brown") + 1))).toBe("brown");
  });
});

describe("stepWord", () => {
  const line = "Let us give 'sense-data' a name.";

  it("should move to the next or previous word, skipping spaces and quotes", () => {
    const give = wordAt(line, line.indexOf("give"));
    expect(cut(line, stepWord(line, give, 1))).toBe("sense-data");
    expect(cut(line, stepWord(line, give, -1))).toBe("us");
  });

  it("should start from the first or last word when there is no word yet", () => {
    expect(cut(line, stepWord(line, null, 1))).toBe("Let");
    expect(cut(line, stepWord(line, null, -1))).toBe("name");
  });

  it("should return null past either end of the text", () => {
    expect(stepWord(line, wordAt(line, line.indexOf("name")), 1)).toBeNull();
    expect(stepWord(line, wordAt(line, 0), -1)).toBeNull();
  });
});

describe("termSpan", () => {
  it("should find a short term inside a selection, without the quotes and spaces around it", () => {
    const selected = " 'a priori'.";
    expect(cut(selected, termSpan(selected))).toBe("a priori");
    expect(cut("common sense", termSpan("common sense"))).toBe("common sense");
    expect(cut("sense-data", termSpan("sense-data"))).toBe("sense-data");
  });

  it("should return null when the selection is a passage, not a term", () => {
    expect(termSpan("the things that are immediately known")).toBeNull();
    expect(termSpan("colours, sounds")).toBeNull();
    expect(termSpan("at all? If")).toBeNull();
    expect(termSpan("...")).toBeNull();
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

  // The cases below are real sentences from the test book (The Problems of Philosophy).
  const sentencesIn = (text: string) => sentenceSpans(text).map((span) => cut(text, span));

  it("should keep a name written with initials in one sentence", () => {
    const text =
      "I have derived valuable assistance from unpublished writings of G. E. Moore and J. M. Keynes: from the former, as regards the relations of sense-data to physical objects, and from the latter as regards probability and induction. I have also profited greatly by the criticisms and suggestions of Professor Gilbert Murray.";
    expect(sentencesIn(text)).toEqual([
      "I have derived valuable assistance from unpublished writings of G. E. Moore and J. M. Keynes: from the former, as regards the relations of sense-data to physical objects, and from the latter as regards probability and induction.",
      "I have also profited greatly by the criticisms and suggestions of Professor Gilbert Murray.",
    ]);
  });

  it("should keep a title or a citation abbreviation with the name after it", () => {
    const text = "But if he believes that Mr. Balfour was the late Prime Minister, he is wrong. (1) Cf. A. N. Whitehead, Introduction to Mathematics (Home University Library).";
    expect(sentencesIn(text)).toEqual([
      "But if he believes that Mr. Balfour was the late Prime Minister, he is wrong.",
      "(1) Cf. A. N. Whitehead, Introduction to Mathematics (Home University Library).",
    ]);
  });

  it("should keep a title and a lettered name inside a quoted sentence", () => {
    const text =
      "The proposition 'a is the so-and-so' means that a has the property so-and-so, and nothing else has. 'Mr. A. is the Unionist candidate for this constituency' means 'Mr. A. is a Unionist candidate for this constituency, and no one else is'. 'The Unionist candidate for this constituency exists' means 'some one is a Unionist candidate for this constituency, and no one else is'.";
    expect(sentencesIn(text)).toEqual([
      "The proposition 'a is the so-and-so' means that a has the property so-and-so, and nothing else has.",
      "'Mr. A. is the Unionist candidate for this constituency' means 'Mr. A. is a Unionist candidate for this constituency, and no one else is'.",
      "'The Unionist candidate for this constituency exists' means 'some one is a Unionist candidate for this constituency, and no one else is'.",
    ]);
  });

  it("should keep common abbreviations with the word after them", () => {
    const text = "He met Dr. Smith in St. Paul, e.g. Berkeley, i.e. Locke. Pens, etc. The end.";
    expect(sentencesIn(text)).toEqual(["He met Dr. Smith in St. Paul, e.g. Berkeley, i.e. Locke.", "Pens, etc.", "The end."]);
  });

  it("should still split after a capital letter that ends a sentence", () => {
    const text = "In our case, the data are merely the known cases of coexistence of A and B. There may be other data, which might be taken into account.";
    expect(sentencesIn(text)).toEqual([
      "In our case, the data are merely the known cases of coexistence of A and B.",
      "There may be other data, which might be taken into account.",
    ]);
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

describe("RichText", () => {
  const html = (text: string, writing = false) => renderToStaticMarkup(createElement(RichText, { text, writing }));

  it("should show emphasis as bold or italic, never as the asterisks the AI typed", () => {
    const answer = [
      "You only see many looks, and you *believe* one **real** shirt is _behind_ them.",
      "So 2 * 3 is still a sum.",
      "**Hard words:**",
      "- *evident* - easy to see",
    ].join("\n");

    expect(html(answer)).toContain(
      "<p>You only see many looks, and you <em>believe</em> one <strong>real</strong> shirt is <em>behind</em> them.</p>",
    );
    expect(html(answer)).toContain("<p>So 2 * 3 is still a sum.</p>");
    expect(html(answer)).toContain("<dt>evident</dt>");
  });

  it("should show an emphasis that is still streaming in without its asterisks", () => {
    expect(html("and you *belie")).toContain("<p>and you <em>belie</em></p>");
    expect(html("and the **")).not.toContain("*");
  });

  it("should end an answer that is still being written with quiet dots after its last word, and only then", () => {
    const dots = ' <span class="writing" aria-hidden="true"></span>';
    const first = "**In simple words:** He doubts it.\n";

    expect(html(`${first}**In context:** Russell asks`, true)).toContain(`<p>He doubts it.</p>`);
    expect(html(`${first}**In context:** Russell asks`, true)).toContain(`<p>Russell asks${dots}</p>`);
    expect(html(`${first}- one\n- two`, true)).toContain(`<li>one</li><li>two${dots}</li>`);
    expect(html(`${first}**Hard words:**\n- doubt - not be sure`, true)).toContain(`<dd>not be sure${dots}</dd>`);
    expect(html(`${first}**Deeper mea`, true)).toContain(`<span>Deeper mea</span>${dots}</h3>`);
    expect(html(`${first}**In context:** Russell asks.`)).not.toContain("writing");
  });
});
