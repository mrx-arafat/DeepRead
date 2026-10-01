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

export type Chapter = {
  id: string;
  title: string;
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
  startPage: number;
  endPage: number;
  wordCount: number;
};

export type ReadingProgress = {
  chapterId: string;
  blockId: string;
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
