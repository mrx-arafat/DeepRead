import type { ParsedBook } from "../../shared/types.ts";

export type PdfParseErrorCode = "not_found" | "invalid_pdf" | "encrypted" | "scanned" | "garbled" | "empty" | "timeout";

export class PdfParseError extends Error {
  code: PdfParseErrorCode;
  constructor(code: PdfParseErrorCode, message: string);
}

export type ParseOptions = {
  useOutline?: boolean;
  openTimeoutMs?: number;
  stepTimeoutMs?: number;
  pageTimeoutMs?: number;
  totalTimeoutMs?: number;
  hardTimeoutMs?: number;
  images?: boolean;
  ocr?: boolean;
  ocrLanguage?: string;
  ocrTimeoutMs?: number;
};

/** Parse in this thread. Every pdf.js call is time-guarded, but a runaway parse still blocks the thread. */
export function parsePdf(filePath: string, options?: ParseOptions): Promise<ParsedBook>;

/** Parse in a worker thread that is killed if it overruns, so a bad PDF cannot hang the caller. */
export function parsePdfIsolated(filePath: string, options?: ParseOptions): Promise<ParsedBook>;
