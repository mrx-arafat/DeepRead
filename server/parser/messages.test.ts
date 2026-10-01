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
    expect(error.message).not.toMatch(/text layer|characters per page|0 of 1|OCR/);
  });

  it("should explain scrambled text like a scan, with the same way out, when the fonts cannot be decoded", () => {
    const error = toParseError(new PdfParseError("garbled", "This PDF's text layer is garbled (fonts without a character map)."));

    expect(error.kind).toBe("scanned");
    expect(error.message).toMatch(/scrambled/);
    expect(error.message).toMatch(/another copy of the book/);
    expect(error.message).not.toMatch(/text layer|character map|OCR/);
  });

  it("should say the file looks damaged and what to do, without the parser's wording, when the PDF cannot be opened", () => {
    const error = toParseError(new PdfParseError("invalid_pdf", "Not a readable PDF: Invalid PDF structure."));

    expect(error.kind).toBe("invalid");
    expect(error.message).toBe("This PDF looks damaged. Try downloading or exporting it again.");
  });

  it("should tell the reader to try again or use a smaller copy when reading the book takes too long", () => {
    const error = toParseError(new PdfParseError("timeout", "Parsing did not finish within 120000 ms."));

    expect(error.message).toMatch(/took too long/);
    expect(error.message).toMatch(/smaller copy/);
    expect(error.message).not.toMatch(/\d{3,}/);
  });
});
