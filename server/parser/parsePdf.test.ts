import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { ParsedBook } from "../../shared/types.ts";
import { parsePdf } from "./parsePdf.mjs";

// The public-domain test book the reader-journey tests read: a Project Gutenberg PDF made from HTML.
const fixture = fileURLToPath(new URL("../../e2e/fixtures/problems-of-philosophy.pdf", import.meta.url));

describe("parsePdf on The Problems of Philosophy", () => {
  let book: ParsedBook;
  beforeAll(async () => {
    book = await parsePdf(fixture);
  }, 60_000);

  it("should give every line of the contents page its own entry, without the stray dot of an empty number column", () => {
    const front = book.chapters[0]!;
    const blocks = front.blocks.map((block) => block.text);
    const rows = blocks.slice(blocks.indexOf("Contents") + 1);
    // As printed on pages 1 and 2 of the PDF, the number column and the title joined by a space.
    expect(rows).toEqual([
      "PREFACE",
      "CHAPTER I. APPEARANCE AND REALITY",
      "CHAPTER II. THE EXISTENCE OF MATTER",
      "CHAPTER III. THE NATURE OF MATTER",
      "CHAPTER IV. IDEALISM",
      "CHAPTER V. KNOWLEDGE BY ACQUAINTANCE AND KNOWLEDGE BY DESCRIPTION",
      "CHAPTER VI. ON INDUCTION",
      "CHAPTER VII. ON OUR KNOWLEDGE OF GENERAL PRINCIPLES",
      "CHAPTER VIII. HOW A PRIORI KNOWLEDGE IS POSSIBLE",
      "CHAPTER IX. THE WORLD OF UNIVERSALS",
      "CHAPTER X. ON OUR KNOWLEDGE OF UNIVERSALS",
      "CHAPTER XI. ON INTUITIVE KNOWLEDGE",
      "CHAPTER XII. TRUTH AND FALSEHOOD",
      "CHAPTER XIII. KNOWLEDGE, ERROR, AND PROBABLE OPINION",
      "CHAPTER XIV. THE LIMITS OF PHILOSOPHICAL KNOWLEDGE",
      "CHAPTER XV. THE VALUE OF PHILOSOPHY",
      "BIBLIOGRAPHICAL NOTE",
    ]);
    expect(front.blocks.slice(-rows.length).every((block) => block.type === "paragraph")).toBe(true);
  });
});
