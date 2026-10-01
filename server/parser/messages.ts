import type { ParseErrorKind } from "../../shared/types.ts";
import { ParseError } from "./errors.ts";
import type { PdfParseError, PdfParseErrorCode } from "./parsePdf.mjs";

// The reader only needs to know what to do next, so the parser's finer codes collapse to these.
// "garbled" (fonts without a character map) needs OCR just like a scan does.
const KINDS: Partial<Record<PdfParseErrorCode, ParseErrorKind>> = {
  scanned: "scanned",
  garbled: "scanned",
  encrypted: "encrypted",
  empty: "empty",
};

// What the reader sees instead of the parser's own wording, which is written for developers.
// Each says what is wrong and what to do next, in words a reader who has never heard of OCR or PDF internals can follow.
const MESSAGES: Partial<Record<PdfParseErrorCode, string>> = {
  scanned:
    "This PDF is a scan (pictures of pages, not words), so DeepRead cannot read it. Use a version of the book with text you can select, or run this one through a text-recognition tool first.",
  garbled:
    "The words in this PDF are scrambled, so DeepRead cannot read it. Use another copy of the book, or run this one through a text-recognition tool first.",
  invalid_pdf: "This PDF looks damaged. Try downloading or exporting it again.",
  timeout: "This book took too long to read, so DeepRead stopped. Try again, or add a smaller copy of the book.",
  not_found: "DeepRead could not open the file it received. Choose the PDF again and try once more.",
};

/** The error for the reader. Anything the table above does not cover keeps the parser's own wording. */
export function toParseError(error: PdfParseError): ParseError {
  return new ParseError(KINDS[error.code] ?? "invalid", MESSAGES[error.code] ?? error.message);
}
