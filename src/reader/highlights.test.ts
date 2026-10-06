import { describe, expect, it } from "vitest";
import type { Block, HighlightColor, HighlightNote } from "../../shared/types.ts";
import { highlightAround, highlightTarget, quoteStart } from "./highlights.ts";
import { termSpan } from "./textRanges.ts";

const block = (id: string, text: string): Block => ({ id, type: "paragraph", text, page: 1 });
const blocks = [
  block("b1", "Is there any knowledge in the world? This question is hard."),
  block("b2", "The table is brown; the table is hard."),
  block("b3", "In daily life, we assume as certain many things."),
];
const textOf = (blockId: string) => blocks.find((item) => item.id === blockId)!.text;

/** A highlight over `quote`, found in its block from `from` on. */
function highlight(id: string, blockId: string, quote: string, from = 0, color: HighlightColor = "yellow"): HighlightNote {
  const offset = textOf(blockId).indexOf(quote.split("\n")[0]!, from);
  return { id, chapterId: "c1", blockId, quote, offset, mode: "highlight", color, lang: "bn" };
}

/** The reader's selection of `quote`, found in its block from `from` on. */
function selection(blockId: string, quote: string, from = 0) {
  return { blockId, quote, offset: textOf(blockId).indexOf(quote.split("\n")[0]!, from) };
}

describe("highlightAround", () => {
  const knowledge = highlight("k", "b1", "any knowledge in the world");
  const secondTable = highlight("t", "b2", "the table is hard", 10, "green");
  const across = highlight("x", "b2", "the table is hard.\nIn daily life", 10, "pink");
  const all = [knowledge, secondTable];
  const around = (quote: string, blockId = "b1", from = 0, highlights = all) =>
    highlightAround(highlights, blocks, selection(blockId, quote, from))?.id ?? null;

  it("should find the highlight a selection lies entirely inside, its edges included", () => {
    expect(around("any knowledge in the world")).toBe("k");
    expect(around("knowledge in")).toBe("k");
  });

  it("should find none for a selection that runs out of a highlight, over two, or in another paragraph", () => {
    expect(around("there any knowledge")).toBeNull();
    expect(around("world? This", "b1", 0, [knowledge, highlight("q", "b1", "? This question")])).toBeNull();
    expect(around("daily life", "b3")).toBeNull();
  });

  it("should tell the same words apart by where they are in the paragraph", () => {
    expect(around("table is hard", "b2", 10)).toBe("t");
    expect(around("table is", "b2", 0)).toBeNull();
  });

  it("should follow a highlight over the paragraphs it runs into", () => {
    expect(around("daily", "b3", 0, [across])).toBe("x");
    expect(around("daily life, we", "b3", 0, [across])).toBeNull();
  });

  it("should pick, of two highlights that both hold the selection, the one painted on top: the later colour, else the newer", () => {
    const blueUnder = highlight("n", "b1", "knowledge in", 0, "blue");
    expect(around("knowledge", "b1", 0, [blueUnder, knowledge])).toBe("n");
    expect(around("knowledge", "b1", 0, [knowledge, highlight("y", "b1", "knowledge in")])).toBe("y");
  });
});

describe("highlightTarget", () => {
  it("should anchor a short selection on its term, without quotes or full stop, so a tap on that term finds the highlight", () => {
    const text = 'Known a priori, and "a priori." again.';
    const page = [block("p", text)];
    const raw = '"a priori."';
    const from = text.indexOf(raw);
    // As the reader's text narrows a short mouse selection before the word card opens: to the term inside it.
    const term = termSpan(raw)!;
    const target = highlightTarget(page, [], { blockId: "p", quote: raw.slice(term.start, term.end), from: from + term.start });
    expect(target).toEqual({ blockId: "p", offset: from + 1, quote: "a priori", around: null });

    const made: HighlightNote = { id: "h", chapterId: "c1", blockId: "p", quote: "a priori", offset: from + 1, mode: "highlight", color: "blue", lang: "bn" };
    // A tap takes the word's own span: on the highlighted "a priori" it offers to change it, on the other one to add one.
    expect(highlightTarget(page, [made], { blockId: "p", quote: "a priori", from: text.lastIndexOf("a priori") })?.around).toBe(made);
    expect(highlightTarget(page, [made], { blockId: "p", quote: "a priori", from: text.indexOf("a priori") })?.around).toBeNull();
  });
});

describe("quoteStart", () => {
  it("should place the selected words at or after where the selection starts in its paragraph", () => {
    const text = textOf("b2");
    expect(quoteStart(blocks, "b2", "the table is", 0)).toEqual({ blockId: "b2", offset: text.indexOf("the table is") });
    expect(quoteStart(blocks, "b2", "table is", 6)).toEqual({ blockId: "b2", offset: text.lastIndexOf("table is") });
  });

  it("should place a selection that starts past a paragraph's last word in the next paragraph", () => {
    const end = textOf("b1").length;
    expect(quoteStart(blocks, "b1", "The table is", end)).toEqual({ blockId: "b2", offset: 0 });
  });

  it("should place a selection over several paragraphs at the end of the first", () => {
    const text = textOf("b1");
    expect(quoteStart(blocks, "b1", "is hard.\nThe table", 30)).toEqual({ blockId: "b1", offset: text.length - "is hard.".length });
  });

  it("should give no place for words that are not where the selection is", () => {
    expect(quoteStart(blocks, "b1", "Not in the book", 0)).toBeNull();
    expect(quoteStart(blocks, "gone", "The table", 0)).toBeNull();
  });
});
