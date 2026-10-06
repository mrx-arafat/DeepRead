// Contract shared by the server and the web app.
// The parser produces `ParsedBook`; the library stores it and serves the views below.

export type Block = {
  /** Stable within the book, e.g. "c3-b12". */
  id: string;
  type: "heading" | "paragraph";
  /** Headings only. */
  level?: 1 | 2 | 3;
  /** Clean text: de-hyphenated, no running headers, footers or page numbers. */
  text: string;
  /** 1-based PDF page where the block starts. */
  page: number;
};

/**
 * Where a section sits: the book's own text, or the matter around it (title page, copyright, contents before it;
 * notes, index, licence after it). The reader opens past front matter, and neither kind counts as reading.
 */
export type SectionKind = "front" | "body" | "back";

export type Chapter = {
  id: string;
  title: string;
  /** Absent in books parsed before sections had kinds; read it as "body". */
  kind?: SectionKind;
  startPage: number;
  endPage: number;
  blocks: Block[];
};

export type ParsedBook = {
  title: string;
  author: string | null;
  pageCount: number;
  chapters: Chapter[];
  /** Human-readable notes about parsing compromises, shown to the reader. */
  warnings: string[];
};

/** Why a PDF could not be turned into a book. */
export type ParseErrorKind = "scanned" | "encrypted" | "invalid" | "empty";

export type ChapterSummary = {
  id: string;
  title: string;
  /** Absent in books parsed before sections had kinds; read it as "body". */
  kind?: SectionKind;
  startPage: number;
  endPage: number;
  wordCount: number;
};

export type ReadingProgress = {
  chapterId: string;
  blockId: string;
  /**
   * Where the line the reader was on starts in the block's text, in characters: the same text whatever the window
   * width or text size. Absent in progress saved before it was kept; read it as the block's start.
   */
  offset?: number;
  updatedAt: string;
  /** Title of that chapter, so the library can say where the reader stopped. */
  chapterTitle: string;
  /** How far through the whole book the reader is, 0 to 100, counted the way the reader's top bar counts it. */
  percent: number;
};

export type BookSummary = {
  id: string;
  title: string;
  author: string | null;
  pageCount: number;
  chapterCount: number;
  wordCount: number;
  addedAt: string;
  progress: ReadingProgress | null;
  /** Page 1 of the PDF is the book's cover, served at /api/books/<id>/cover. Without one the library draws a cover. */
  hasCover: boolean;
};

export type BookDetail = BookSummary & {
  chapters: ChapterSummary[];
  warnings: string[];
};

/** What the reader can correct about a book. A missing field stays as it is; an empty or null author clears it. */
export type BookUpdate = {
  title?: string;
  author?: string | null;
};

export type ApiError = {
  error: string;
  message: string;
};

/** Languages the reader can pick as their own. Code is BCP 47, name is what prompts use. */
export const LANGUAGES = {
  bn: "Bangla",
  hi: "Hindi",
  ur: "Urdu",
  ar: "Arabic",
  es: "Spanish",
  fr: "French",
  id: "Indonesian",
  tr: "Turkish",
} as const;

export type LangCode = keyof typeof LANGUAGES;

export const DEFAULT_LANG: LangCode = "bn";

/** The AI tools DeepRead can answer with, in the order it prefers them. */
export const AI_PROVIDERS = { claude: "Claude Code", codex: "Codex" } as const;

export type AiProviderId = keyof typeof AI_PROVIDERS;

/** Which AI tools are installed on this computer, and which one answers (null: none is installed). */
export type AiStatus = {
  active: AiProviderId | null;
  providers: Array<{ id: AiProviderId; name: string; installed: boolean }>;
};

/** Fast, keyless lookup shown the instant a word is tapped. */
export type QuickTranslation = {
  text: string;
  translation: string;
  lang: LangCode;
};

/** What the reader asked the AI to do with a piece of the book. */
export type ExplainMode =
  /** Meaning of one word or phrase in this sentence. */
  | "word"
  /** Rewrite the passage in plain, simple language. */
  | "simple"
  /** Explain with a concrete everyday example. */
  | "example"
  /** Explain in the reader's own language. */
  | "native";

/** A question the reader asked about a passage. Kept with the book; the server caches the answer. */
export type Note = {
  id: string;
  chapterId: string;
  blockId: string;
  /** The text the reader selected. */
  quote: string;
  mode: ExplainMode;
  /** The language it was asked in. A card keeps it: picking another language later must not ask again. */
  lang: LangCode;
};

/** How much room the books take, where they are kept, and the most they may take (null: no limit). */
export type StorageUsage = {
  used: number;
  limit: number | null;
  where: "local" | "r2";
};

export type ExplainRequest = {
  bookId: string;
  chapterId: string;
  blockId: string;
  /** The exact text the reader tapped or selected. */
  selection: string;
  mode: ExplainMode;
  lang: LangCode;
};

export type ChapterAidKind = "preview" | "recap" | "quiz";

export type QuizQuestion = {
  question: string;
  options: string[];
  /** Index into `options`. */
  answer: number;
  /** Why that answer is right, in simple words. */
  why: string;
};

export type ChapterAid =
  | { kind: "preview"; text: string }
  | { kind: "recap"; text: string }
  | { kind: "quiz"; questions: QuizQuestion[] };

export type AskRequest = {
  bookId: string;
  chapterId: string;
  question: string;
  history: { role: "user" | "assistant"; text: string }[];
  lang: LangCode;
};

export type ChapterAidRequest = {
  bookId: string;
  chapterId: string;
  kind: ChapterAidKind;
  lang: LangCode;
  /** Ignore the cached answer and generate a fresh one. */
  refresh?: boolean;
};

export type SpeechBoundary = {
  /** Milliseconds from the start of the audio. */
  offsetMs: number;
  durationMs: number;
  text: string;
};
