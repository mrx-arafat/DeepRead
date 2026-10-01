import type { ParsedBook } from "../../shared/types.ts";
import { toParseError } from "./messages.ts";
import { PdfParseError, parsePdfIsolated } from "./parsePdf.mjs";

/** Turn a PDF on disk into chapters and clean paragraphs. Throws ParseError when it cannot become a book. */
export async function parsePdf(filePath: string): Promise<ParsedBook> {
  try {
    return await parsePdfIsolated(filePath);
  } catch (err) {
    if (!(err instanceof PdfParseError)) throw err;
    // The reader gets a plain sentence; the parser's own wording is what a developer needs.
    console.warn(`PDF could not be read (${err.code}): ${err.message}`);
    throw toParseError(err);
  }
}
