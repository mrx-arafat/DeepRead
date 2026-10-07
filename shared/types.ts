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

/** A reader's manual shelf state, independent of how far they have scrolled. */
export type ReadingStatus = "saved" | "reading" | "finished";

export type BookSummary = {
  id: string;
  title: string;
  author: string | null;
  pageCount: number;
  chapterCount: number;
  wordCount: number;
  addedAt: string;
  progress: ReadingProgress | null;
  readingStatus: ReadingStatus;
  /** Page 1 of the PDF is the book's cover, served at /api/books/<id>/cover. Without one the library draws a cover. */
  hasCover: boolean;
  /** When the reader pinned the book to the top of their library; absent when it is not pinned. Pins are the reader's own, shared books included. */
  pinnedAt?: string;
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
export const AI_PROVIDERS = { claude: "Claude Code", codex: "Codex", openrouter: "API Model" } as const;

/** What each helper is, for the admin who gives it to readers. */
export const AI_PROVIDER_HELP = {
  claude: "Claude Code on this computer, with the admin's Claude account.",
  codex: "Codex on this computer, with the admin's ChatGPT account.",
  openrouter: "An API call to an AI model on the admin's key, not anyone's Claude or Codex sign-in.",
} as const;

export type AiProviderId = keyof typeof AI_PROVIDERS;

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && Object.hasOwn(AI_PROVIDERS, value);
}

/**
 * Which AI helpers can answer, and which one does (null: none can). A command-line tool can answer when it is installed on
 * this computer; the API model, when the admin has given it a key and a model. With profiles on, a reader may use only
 * the helpers the admin gave them, and `allowed` says which.
 */
export type AiStatus = {
  /** With profiles: the admin's name, whose helpers these are. A reader is told they are using "Arafat's Claude Code". */
  owner?: string;
  active: AiProviderId | null;
  providers: Array<{
    id: AiProviderId;
    name: string;
    installed: boolean;
    /** For the API model: the model that answers, or what it still needs. */
    detail?: string;
    /** With profiles: whether the admin gave this reader the helper. Absent when nothing limits who may use it. */
    allowed?: boolean;
    /** With profiles: this reader has asked the admin for it, and the admin has not answered. */
    requested?: boolean;
  }>;
};

/** What the admin page shows of the OpenRouter helper. The key itself is never sent to a browser. */
export type OpenRouterView = {
  keySet: boolean;
  /** Where the key in use comes from: what the admin saved wins over .env. */
  keySource: "admin" | "env" | null;
  /** The last four characters of the key, so the admin can tell which one is in use. */
  keyHint: string | null;
  model: string | null;
  modelSource: "admin" | "env" | null;
  /** The most requests a reader may make of it in a day; 0 for no limit. The admin's own profile is never held to it. */
  dailyLimit: number;
  /** Requests made today, by reader id. */
  usedToday: Record<string, number>;
  /**
   * Where the model is asked: the address of an OpenAI-compatible Chat Completions API, without /chat/completions.
   * OpenRouter (https://openrouter.ai/api/v1) unless the admin or .env points it at another, such as OpenAI, DeepSeek,
   * Groq, or Ollama and LM Studio on a computer of the admin's own.
   */
  baseUrl: string;
  /** Where the address in use comes from: what the admin saved wins over .env; null is the OpenRouter default. */
  baseUrlSource: "admin" | "env" | null;
};

/** The address the API model asks when nothing else is set. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * How a chapter is put into the reader's language under each paragraph, by a translation service and not an AI helper.
 * `auto` asks Microsoft first and Google if Microsoft cannot answer.
 */
export const TRANSLATION_ENGINES = ["auto", "microsoft", "google"] as const;
export type TranslationEngine = (typeof TRANSLATION_ENGINES)[number];

/** The admin's choice for chapter translation, which holds for every reader. */
export type TranslationSettings = {
  /** Whether readers may show a chapter's translation. The admin's own profile always may. */
  enabled: boolean;
  engine: TranslationEngine;
};

/** A chapter's paragraphs and headings in one language, by block id. Kept with the book, so each is translated once. */
export type ChapterTranslation = {
  lang: LangCode;
  blocks: Record<string, string>;
  /** Which service made the translations sent this time. */
  engine: "microsoft" | "google";
};

/** The admin's try of the chosen service on one sentence, to see that it works and how it reads. */
export type TranslationTest =
  | { ok: true; engine: "microsoft" | "google"; ms: number; sample: string; translation: string }
  | { ok: false; message: string };

/** The admin page's view, with which helper answers for everyone right now, and what the key has spent when OpenRouter says. */
export type OpenRouterAdminView = OpenRouterView & {
  active: AiProviderId | null;
  /** US dollars the key has spent and may spend (limit is null for a key with none). Absent when OpenRouter cannot say. */
  balance?: { used: number; limit: number | null };
};

/** A reader's request for an AI helper, waiting for the admin to approve it or turn it down. */
export type AiRequest = { profile: PublicProfile; helper: AiProviderId; requestedAt: string };

/** `null` takes away what the admin saved, which goes back to what .env says; a missing field stays as it is. */
export type OpenRouterPatch = { apiKey?: string | null; model?: string | null; dailyLimit?: number | null; baseUrl?: string | null };

export type OpenRouterModel = {
  id: string;
  name: string;
  free: boolean;
  /** US dollars for a million tokens in and out; null where OpenRouter prices it by what the request turns out to need. */
  promptPerMillion: number | null;
  completionPerMillion: number | null;
};

export type OpenRouterTest =
  | {
      ok: true;
      model: string;
      ms: number;
      /** What the key has spent and may spend, in US dollars, when OpenRouter says (limit is null for a key with none). */
      balance?: { used: number; limit: number | null };
    }
  | { ok: false; message: string };

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

/** The highlighter colours a reader can mark a passage with, in the order the selection bar offers them. */
export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink"] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === "string" && (HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

/** What every note keeps: the passage it is about. */
type NotePassage = {
  id: string;
  chapterId: string;
  blockId: string;
  /** The text the reader selected. */
  quote: string;
  /** The language it was made in. A question card keeps it: picking another language later must not ask again. */
  lang: LangCode;
};

export const MAX_REFLECTION_CHARS = 5_000;
export const MAX_SAVED_ANSWER_CHARS = 20_000;

/** A question the reader asked about a passage, shown as a card in the margin. */
export type QuestionNote = NotePassage & {
  mode: ExplainMode;
  /** Absent on legacy questions saved before passage offsets were recorded. */
  offset?: number;
  savedAnswer?: string;
};

/** The reader's own words at an exact character offset in a paragraph. */
export type ReflectionNote = NotePassage & { mode: "reflection"; offset: number; text: string };

/** A passage the reader marked in a highlighter colour. Theirs alone: it never goes to the AI. */
export type HighlightNote = NotePassage & {
  mode: "highlight";
  color: HighlightColor;
  /** Where the quote starts in block `blockId`'s text, in characters: the same words can come twice in a paragraph. */
  offset: number;
};

/** What the reader keeps with a book, one change at a time (shared/notes.ts). */
export type Note = QuestionNote | HighlightNote | ReflectionNote;

/** How much room the books take, where they are kept, and the most they may take (null: no limit). */
export type StorageUsage = {
  /** This reader's books. */
  used: number;
  /** Everyone's books together: the limit is shared. The same as `used` when there are no profiles. */
  total: number;
  limit: number | null;
  where: "local" | "r2";
};

/** What a reader is told about the room: their own books only, never what other profiles keep. */
export type StorageView = Omit<StorageUsage, "total">;

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
  /** The AI helpers the admin gave this profile. The admin's own can use every one that works. */
  ai: AiProviderId[];
  /** The helpers this profile has asked for, and the admin has not answered. */
  aiRequested: AiProviderId[];
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
export type ProfileUpdate = {
  name?: string;
  code?: string;
  preset?: AvatarPreset;
  badge?: string;
  /** The AI helpers this profile may use, replacing the list. Giving one answers a request for it. */
  ai?: AiProviderId[];
  /** Turns down these requests for a helper, without giving it. */
  aiDismiss?: AiProviderId[];
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

export type ChapterAidKind = "preview" | "recap" | "quiz" | "closing";

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
  | { kind: "quiz"; questions: QuizQuestion[] }
  /** The quiet line at the end of a main chapter: plain text, one or two sentences, always English. */
  | { kind: "closing"; text: string };

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
