import type { ParsedBook } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import type { CoverImage } from "./cover.ts";
import type { Library } from "./library.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Profiles } from "./profiles.ts";
import type { QuickTranslate } from "./translate.ts";

/** Implemented in parser/. Throws ParseError for PDFs that cannot become a book. */
export type ParsePdf = (filePath: string) => Promise<ParsedBook>;

/** Implemented in cover.ts. Page 1 of the PDF as the book's cover, or null when it has none. Never rejects. */
export type RenderCover = (pdfPath: string) => Promise<CoverImage | null>;

/** Profiles mode, when ADMIN_PASSKEY is set: who may sign in, and the key that signs their session cookies. */
export type Accounts = {
  profiles: Profiles;
  /** From session-token.ts sessionKey: the secret on this computer bound to ADMIN_PASSKEY. */
  sessionKey: Uint8Array;
};

type SharedDeps = {
  parsePdf: ParsePdf;
  renderCover: RenderCover;
  /** The AI helper that answers, and which ones can. */
  llm: Ai;
  /** The admin's OpenRouter key and model, which answer for readers whose computer has no helper of its own. */
  openrouter?: OpenRouter;
  quickTranslate: QuickTranslate;
  /** Built web app to serve (production only). Unknown paths fall back to its index.html. */
  webRoot?: string;
  /** When set, devices on other host names (a tunnel) may use the app after unlocking with this key. */
  remoteKey?: string;
  /** When set (DEEPREAD_PUBLIC_URL, as an origin), anyone may use the app at this address, signing in with a profile's code. */
  publicOrigin?: string;
};

/** One library and no sign-in (ADMIN_PASSKEY not set), or profiles, each reading from a library of its own. */
export type AppDeps = SharedDeps &
  (
    | {
        /** The books, in the data folder or an R2 bucket. Made by the caller, which also looks for the covers of books stored before covers were kept. */
        library: Library;
        accounts?: undefined;
      }
    | { accounts: Accounts; library?: undefined }
  );
