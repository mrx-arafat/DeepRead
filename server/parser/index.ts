import type { ParsedBook, ParseErrorKind } from "../../shared/types.ts";
import { ParseError } from "./errors.ts";
import { PdfParseError, parsePdfIsolated } from "./parsePdf.mjs";

// The reader only needs to know what to do next, so the parser's finer codes collapse to these.
// "garbled" (fonts without a character map) needs OCR just like a scan does.
const KINDS: Partial<Record<PdfParseError["code"], ParseErrorKind>> = {
  scanned: "scanned",
  garbled: "scanned",
  encrypted: "encrypted",
  empty: "empty",
};

/** Turn a PDF on disk into chapters and clean paragraphs. Throws ParseError when it cannot become a book. */
export async function parsePdf(filePath: string): Promise<ParsedBook> {
  try {
    return await parsePdfIsolated(filePath);
  } catch (err) {
    if (err instanceof PdfParseError) throw new ParseError(KINDS[err.code] ?? "invalid", err.message);
    throw err;
  }
}
