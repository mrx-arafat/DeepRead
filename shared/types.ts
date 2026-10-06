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
  /**
   * Who shared this book with the reader; absent for their own books. A shared book is read only, its `addedAt` is when
   * it was shared, and its `progress` is the reader's own.
   */
  sharedBy?: PublicProfile;
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
  /** This reader's books. */
  used: number;
  /** Everyone's books together: the limit is shared. The same as `used` when there are no profiles. */
  total: number;
  limit: number | null;
  where: "local" | "r2";
};

/** The built-in pictures a profile can wear. src/profiles/avatars.tsx draws each one. */
export const AVATAR_PRESETS = [
  "smile-blue",
  "smile-amber",
  "shades-teal",
  "cat-rose",
  "owl-violet",
  "robot-mint",
  "star-coral",
  "moon-navy",
] as const;

export type AvatarPreset = (typeof AVATAR_PRESETS)[number];

/** A built-in picture, and an uploaded photo that wins over it while there is one. */
export type ProfileAvatar = {
  preset: AvatarPreset;
  /** Changes with every upload, so the photo's address changes too: /api/profiles/<id>/avatar?v=<photo>. Null: no photo. */
  photo: string | null;
};

/** What anyone may see of a profile: the "Who's reading?" page shows these before anyone signs in. */
export type PublicProfile = {
  id: string;
  name: string;
  avatar: ProfileAvatar;
  /** The admin's profile: its code is ADMIN_PASSKEY, and signing in with it opens /admin. */
  admin: boolean;
  /** The small label shown beside the name: whatever the admin gave this profile, "Admin" for the admin's until then, else none. */
  badge: string | null;
};

/** Someone a book is shared with, and since when. */
export type BookShare = { profile: PublicProfile; sharedAt: string };

/** The reader's sharing page: the books they share and with whom, and the books shared with them. */
export type SharingOverview = {
  given: Array<SharedBookInfo & { with: BookShare[] }>;
  /** `bookId` is the id the book goes by on the reader's shelf. */
  received: Array<SharedBookInfo & { from: PublicProfile; sharedAt: string }>;
};

/** Enough of a book to show its cover and name it. */
type SharedBookInfo = { bookId: string; title: string; author: string | null; hasCover: boolean };

/** One share as the admin dashboard lists it. */
export type AdminShare = { owner: PublicProfile; recipient: PublicProfile; bookId: string; title: string; sharedAt: string };

/** A profile as the admin dashboard shows it. */
export type AdminProfile = PublicProfile & {
  createdAt: string;
  bookCount: number;
  /** Bytes its books take. */
  used: number;
};

/** Who is reading in this browser, until `expiresAt` (30 days after signing in). */
export type Session = {
  profile: PublicProfile;
  /** Whether /admin opens: true for the admin, and for the admin while viewing as someone else. */
  admin: boolean;
  /** The admin, while they view DeepRead as `profile`. */
  impersonatedBy: PublicProfile | null;
  expiresAt: string;
};

/**
 * "single": no profiles (ADMIN_PASSKEY is not set), so DeepRead opens straight to its one library.
 * "profiles": everyone picks a profile and gives its code; `session` is null until they do.
 */
export type SessionInfo = { mode: "single" } | { mode: "profiles"; session: Session | null };

export type NewProfile = { name: string; code: string; preset: AvatarPreset; badge?: string };

/** A missing field stays as it is; an empty badge takes the badge away. A new code signs that profile out everywhere. */
export type ProfileUpdate = { name?: string; code?: string; preset?: AvatarPreset; badge?: string };

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
