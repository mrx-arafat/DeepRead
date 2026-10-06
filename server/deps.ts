import type { ParsedBook } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import type { CoverImage } from "./cover.ts";
import type { Library } from "./library.ts";
import type { QuickTranslate } from "./translate.ts";

/** Implemented in parser/. Throws ParseError for PDFs that cannot become a book. */
export type ParsePdf = (filePath: string) => Promise<ParsedBook>;

/** Implemented in cover.ts. Page 1 of the PDF as the book's cover, or null when it has none. Never rejects. */
export type RenderCover = (pdfPath: string) => Promise<CoverImage | null>;

export type AppDeps = {
  /** The books, in the data folder or an R2 bucket. Made by the caller, which also looks for the covers of books stored before covers were kept. */
  library: Library;
  parsePdf: ParsePdf;
  renderCover: RenderCover;
  /** The AI tool that answers, and which ones are installed. */
  llm: Ai;
  quickTranslate: QuickTranslate;
  /** Built web app to serve (production only). Unknown paths fall back to its index.html. */
  webRoot?: string;
  /** When set, devices on other host names (a tunnel) may use the app after unlocking with this key. */
  remoteKey?: string;
};
