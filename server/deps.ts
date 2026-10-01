import type { ParsedBook } from "../shared/types.ts";
import type { Llm } from "./llm.ts";
import type { QuickTranslate } from "./translate.ts";

/** Implemented in parser/. Throws ParseError for PDFs that cannot become a book. */
export type ParsePdf = (filePath: string) => Promise<ParsedBook>;

export type AppDeps = {
  dataDir: string;
  parsePdf: ParsePdf;
  llm: Llm;
  quickTranslate: QuickTranslate;
  /** Built web app to serve (production only). Unknown paths fall back to its index.html. */
  webRoot?: string;
  /** When set, devices on other host names (a tunnel) may use the app after unlocking with this key. */
  remoteKey?: string;
};
