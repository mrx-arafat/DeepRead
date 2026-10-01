import { describe, expect, it } from "vitest";
import { toParseError } from "./messages.ts";
import { PdfParseError } from "./parsePdf.mjs";

describe("toParseError", () => {
  it("should tell the reader a scanned PDF is made of pictures and what to use instead when the parser finds no text", () => {
    const parserText =
      "This PDF has no usable text layer: only 0 of 1 pages contain text (0.0 characters per page on average). It looks like a scanned book and needs OCR before it can be read.";
    const error = toParseError(new PdfParseError("scanned", parserText));

    expect(error.kind).toBe("scanned");
    expect(error.message).toMatch(/scan \(pictures of pages/);
    expect(error.message).toMatch(/Use a version of the book with text you can select/);
    expect(error.message).not.toMatch(/text layer|characters per page|0 of 1/);
  });

  it("should explain scrambled text like a scan, with the same way out, when the fonts cannot be decoded", () => {
    const error = toParseError(new PdfParseError("garbled", "This PDF's text layer is garbled (fonts without a character map)."));

    expect(error.kind).toBe("scanned");
    expect(error.message).toMatch(/scrambled/);
    expect(error.message).toMatch(/another copy of the book/);
    expect(error.message).not.toMatch(/text layer|character map/);
  });
});
