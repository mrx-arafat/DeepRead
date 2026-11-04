import type { NoteChange } from "../shared/notes.ts";
import type {
  AdminProfile,
  AdminShare,
  AiProviderId,
  AiRequest,
  AiStatus,
  ApiError,
  BookDetail,
  BookShare,
  BookSummary,
  BookUpdate,
  Chapter,
  ChapterAid,
  ChapterAidRequest,
  ChapterTranslation,
  HandoffSettings,
  LangCode,
  NewProfile,
  Note,
  OpenRouterAdminView,
  OpenRouterModel,
  OpenRouterPatch,
  OpenRouterTest,
  ProfileUpdate,
  PublicProfile,
  QuickTranslation,
  ReadingProgress,
  ReadingStatus,
  ResumeContextResponse,
  Session,
  SessionInfo,
  SharingOverview,
  StorageView,
  TranslationSettings,
  TranslationTest,
} from "../shared/types.ts";
import { currentReader, progressFiler } from "./library/shelfCache.ts";

export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
  }
}

export const NOT_REACHABLE = "DeepRead is not reachable. Check that it is running, then try again.";

async function failure(res: Response): Promise<ApiFailure> {
  const body = (await res.json().catch(() => null)) as Partial<ApiError> | null;
  // No JSON sentence means no DeepRead answered: a proxy or a stopped server replied with a page of its own.
  return new ApiFailure(body?.error ?? "unknown", body?.message ?? NOT_REACHABLE, res.status);
}

/** `fetch`, except that a request which never reached DeepRead fails with a sentence, not the browser's "Failed to fetch". */
async function connect(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (error) {
    // A request the caller cancelled is not a failure to report.
    if (init?.signal?.aborted) throw error;
    throw new ApiFailure("unreachable", NOT_REACHABLE, 0);
  }
}

/** Fired on window when DeepRead answers that nobody is signed in (the session ended): App shows the profiles. */
export const SIGNED_OUT_EVENT = "deepread:signed-out";

/** What an upload reports while it runs: the bytes the browser has sent of the whole request. */
export interface UploadWatch {
  onSent?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * `connect` for a body worth watching: XMLHttpRequest reports the bytes it has sent, which fetch cannot. The answer comes
 * back as a Response, so it is read the same way as any other. An abort rejects with the same AbortError fetch gives.
 */
function connectWatched(path: string, body: FormData, { onSent, signal }: UploadWatch): Promise<Response> {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException("The upload was cancelled.", "AbortError");
    if (signal?.aborted) return reject(aborted());
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.responseType = "blob";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onSent?.(event.loaded, event.total);
    };
    // The last progress event can come before the whole body has gone, so the end of the upload is told on its own.
    xhr.upload.onload = (event) => onSent?.(event.total || event.loaded, event.total || event.loaded);
    xhr.onload = () => resolve(new Response(xhr.status === 204 ? null : (xhr.response as Blob), { status: xhr.status }));
    xhr.onerror = () => reject(new ApiFailure("unreachable", NOT_REACHABLE, 0));
    xhr.onabort = () => reject(aborted());
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** The response, when DeepRead answered with success; anything else throws an ApiFailure. */
async function accepted(res: Response): Promise<Response> {
  if (!res.ok) {
    const error = await failure(res);
    if (error.code === "sign_in_required") {
      sessionChanging();
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    }
    throw error;
  }
  return res;
}

/** The response of a request DeepRead answered with success; anything else throws an ApiFailure. */
async function accept(path: string, init?: RequestInit): Promise<Response> {
  return accepted(await connect(path, init));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await accept(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Only wait for saves that can affect this read: all books for the shelf, this book for its detail. Keep every pending
// save, since requests can finish out of order. An unrelated book should open without waiting for the one just left.
const saving = new Map<string, Set<Promise<void>>>();
const SAVE_WAIT_MS = 2000;

async function afterSaving(bookId?: string): Promise<void> {
  const pending = bookId === undefined ? [...saving.values()].flatMap((saves) => [...saves]) : [...(saving.get(bookId) ?? [])];
  if (!pending.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(pending), new Promise((resolve) => (timer = setTimeout(resolve, SAVE_WAIT_MS)))]);
  clearTimeout(timer);
}

async function bookDetail(id: string): Promise<BookDetail> {
  await afterSaving(id);
  return request<BookDetail>(`/api/books/${id}`);
}

// A book's details asked for as the reader opens it from the library, before the reader page has drawn: the page takes
// this answer instead of asking again. Taken once, by the same reader, within EARLY_MS. Anything this browser changes in
// the book drops it, so the page never gets details older than what its own request would have brought.
const early = new Map<string, { reader: string | null; at: number; detail: Promise<BookDetail> }>();
const EARLY_MS = 5000;

function changing(id: string): void {
  early.delete(id);
}

// The shelf asked for as the app starts, beside the session question rather than after it: the server answers for the
// browser's cookie, so the list needs nothing from that answer. The library's first list takes it, once. Signing in,
// out or as someone else drops it, as it is then another reader's; a failure is asked again, never reported from here.
let startupList: Promise<BookSummary[]> | null = null;

function sessionChanging(): void {
  startupList = null;
}

export const api = {
  /** Asks for the shelf now, as the app starts on the library: its first `listBooks` takes the answer. */
  prefetchBooks: (): void => {
    startupList = request<BookSummary[]>("/api/books");
    startupList.catch(() => {});
  },
  listBooks: async () => {
    const asked = startupList;
    startupList = null;
    if (asked) {
      try {
        return await asked;
      } catch {
        // Asked again below, for the reader signed in now.
      }
    }
    await afterSaving();
    return request<BookSummary[]>("/api/books");
  },
  getBook: (id: string): Promise<BookDetail> => {
    const asked = early.get(id);
    early.delete(id);
    if (asked && asked.reader === currentReader() && Date.now() - asked.at < EARLY_MS) return asked.detail;
    return bookDetail(id);
  },
  /** Asks for the book's details now, for the reader page that is about to open it (`getBook` takes the answer). */
  prefetchBook: (id: string): void => {
    const detail = bookDetail(id);
    // Nobody may take it: a failure is the page's to report when it asks again.
    detail.catch(() => {});
    early.set(id, { reader: currentReader(), at: Date.now(), detail });
  },
  updateBook: (id: string, update: BookUpdate) => {
    changing(id);
    return request<BookDetail>(`/api/books/${id}`, json("PATCH", update));
  },
  deleteBook: (id: string) => {
    changing(id);
    return request<void>(`/api/books/${id}`, { method: "DELETE" });
  },
  /** Pins the book to the top of the reader's shelf. Resolves with the time the server pinned it. */
  pinBook: async (id: string) => {
    changing(id);
    return (await request<{ pinnedAt: string }>(`/api/books/${id}/pin`, { method: "PUT" })).pinnedAt;
  },
  unpinBook: (id: string) => {
    changing(id);
    return request<void>(`/api/books/${id}/pin`, { method: "DELETE" });
  },
  setReadingStatus: async (id: string, status: ReadingStatus): Promise<ReadingStatus> => {
    changing(id);
    return (await request<{ readingStatus: ReadingStatus }>(`/api/books/${id}/reading-status`, json("PUT", { status }))).readingStatus;
  },
  getChapter: (bookId: string, chapterId: string, signal?: AbortSignal) =>
    request<Chapter>(`/api/books/${bookId}/chapters/${chapterId}`, { signal }),
  getResumeContext: (bookId: string, progress: ReadingProgress, signal?: AbortSignal) => {
    const query = new URLSearchParams({ chapterId: progress.chapterId, blockId: progress.blockId, offset: String(progress.offset ?? 0) });
    return request<ResumeContextResponse>(`/api/books/${bookId}/resume?${query}`, { signal });
  },
  uploadBook: async (file: File, watch: UploadWatch = {}): Promise<{ book: BookDetail; alreadyHad: boolean }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await accepted(await connectWatched("/api/books", form, watch));
    // 201 is a new book; 200 means this exact file is already in the library and nothing was added.
    return { book: (await res.json()) as BookDetail, alreadyHad: res.status === 200 };
  },
  saveProgress: (bookId: string, chapterId: string, blockId: string, offset: number) => {
    changing(bookId);
    const file = progressFiler();
    // `keepalive`: the save made as the page closes is still delivered.
    const done = request<ReadingProgress>(`/api/books/${bookId}/progress`, { ...json("PUT", { chapterId, blockId, offset }), keepalive: true }).then(
      (progress) => {
        file(bookId, progress);
        return progress;
      },
    );
    let saves = saving.get(bookId);
    if (!saves) saving.set(bookId, (saves = new Set()));
    const settled = done.then(() => {}, () => {}).finally(() => {
      saves.delete(settled);
      if (!saves.size) saving.delete(bookId);
    });
    saves.add(settled);
    return done;
  },
  getNotes: (bookId: string, signal?: AbortSignal) => request<Note[]>(`/api/books/${bookId}/notes`, { signal }),
  changeNote: (bookId: string, change: NoteChange) =>
    change.kind === "put"
      ? request<void>(`/api/books/${bookId}/notes/${encodeURIComponent(change.note.id)}`, json("PUT", { note: change.note, before: change.before }))
      : request<void>(`/api/books/${bookId}/notes/${encodeURIComponent(change.id)}`, { method: "DELETE" }),
  storage: () => request<StorageView>("/api/storage"),

  /** Who one of the reader's own books is shared with. */
  bookShares: (bookId: string) => request<BookShare[]>(`/api/books/${bookId}/shares`),
  shareBook: (bookId: string, profileId: string) => request<void>(`/api/books/${bookId}/shares/${profileId}`, { method: "PUT" }),
  /** Their notes and place in it are kept, hidden, in case it is shared with them again. */
  unshareBook: (bookId: string, profileId: string) => request<void>(`/api/books/${bookId}/shares/${profileId}`, { method: "DELETE" }),
  sharing: () => request<SharingOverview>("/api/shares"),

  session: () => request<SessionInfo>("/api/session"),
  profiles: () => request<PublicProfile[]>("/api/profiles"),
  /** Signs in for 30 days. Rejects with code "wrong_code" (401) or "too_many_tries" (429). */
  signIn: (profileId: string, code: string) => {
    sessionChanging();
    return request<Session>("/api/session", json("POST", { profileId, code }));
  },
  signOut: () => {
    sessionChanging();
    return request<void>("/api/session", { method: "DELETE" });
  },

  adminProfiles: () => request<AdminProfile[]>("/api/admin/profiles"),
  createProfile: (profile: NewProfile) => request<AdminProfile>("/api/admin/profiles", json("POST", profile)),
  updateProfile: (id: string, update: ProfileUpdate) => request<AdminProfile>(`/api/admin/profiles/${id}`, json("PATCH", update)),
  /** A PNG, JPEG or WebP of up to 5 MB; DeepRead keeps a square copy. */
  uploadProfilePhoto: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<AdminProfile>(`/api/admin/profiles/${id}/photo`, { method: "PUT", body: form });
  },
  removeProfilePhoto: (id: string) => request<AdminProfile>(`/api/admin/profiles/${id}/photo`, { method: "DELETE" }),
  /** Removes the profile and every book, note and answer it has. */
  deleteProfile: (id: string) => request<void>(`/api/admin/profiles/${id}`, { method: "DELETE" }),
  /** Signs the profile out on every device it is signed in on. Rejects with 400 for the admin's own profile. */
  signOutProfile: (id: string) => request<void>(`/api/admin/profiles/${id}/sign-out`, { method: "POST" }),
  /** The admin reads as `id` until stopImpersonating. */
  impersonate: (id: string) => {
    sessionChanging();
    return request<Session>(`/api/admin/impersonate/${id}`, { method: "POST" });
  },
  stopImpersonating: () => {
    sessionChanging();
    return request<Session>("/api/admin/impersonate", { method: "DELETE" });
  },
  adminShares: () => request<AdminShare[]>("/api/admin/shares"),
  adminStopShare: (share: AdminShare) =>
    request<void>(`/api/admin/shares/${share.owner.id}/${share.bookId}/${share.recipient.id}`, { method: "DELETE" }),
  translate: (text: string, lang: LangCode, signal?: AbortSignal) =>
    request<QuickTranslation>(
      `/api/translate?q=${encodeURIComponent(text)}&lang=${lang}`,
      { signal },
    ),
  /**
   * The quiet line after a chapter, sent whole rather than streamed. Anything but a line of text (a failure, a limit
   * reached, an answer of another shape) rejects, so the caller can show its own line instead.
   */
  chapterClosing: async (bookId: string, chapterId: string, lang: LangCode, signal?: AbortSignal): Promise<string> => {
    const body: ChapterAidRequest = { bookId, chapterId, kind: "closing", lang };
    const aid = await request<ChapterAid | undefined>("/api/ai/chapter", { ...json("POST", body), signal });
    if (aid?.kind !== "closing" || typeof aid.text !== "string" || !aid.text.trim()) {
      throw new ApiFailure("closing_invalid", "The closing line did not come back as text.", 502);
    }
    return aid.text.trim();
  },
  aiStatus: () => request<AiStatus>("/api/ai/providers"),
  chooseAi: (id: AiProviderId) => request<AiStatus>("/api/ai/provider", json("PUT", { id })),
  /** Asks the admin for a helper the reader was not given. */
  requestAi: (id: AiProviderId) => request<AiStatus>("/api/ai/request", json("POST", { id })),
  /** What readers have asked the admin for, oldest first. */
  aiRequests: () => request<AiRequest[]>("/api/admin/ai-requests"),
  /** Gives the reader the helper they asked for, at once. Rejects with 409 when this server does not have it. */
  approveAiRequest: (profileId: string, helper: AiProviderId) =>
    request<AdminProfile>(`/api/admin/ai-requests/${profileId}/${helper}/approve`, { method: "POST" }),
  /** Turns the request down without giving anything. */
  declineAiRequest: (profileId: string, helper: AiProviderId) =>
    request<AdminProfile>(`/api/admin/ai-requests/${profileId}/${helper}`, { method: "DELETE" }),
  adminApiModel: () => request<OpenRouterAdminView>("/api/admin/openrouter"),
  saveApiModel: (patch: OpenRouterPatch) => request<OpenRouterAdminView>("/api/admin/openrouter", json("PUT", patch)),
  testApiModel: () => request<OpenRouterTest>("/api/admin/openrouter/test", { method: "POST" }),
  apiModelList: () => request<OpenRouterModel[]>("/api/admin/openrouter/models"),
  /** A chapter in the reader's language, paragraph by paragraph. 403 translation_off when the admin turned it off for readers. */
  chapterTranslation: (bookId: string, chapterId: string, lang: LangCode, signal?: AbortSignal) =>
    request<ChapterTranslation>(`/api/books/${bookId}/chapters/${encodeURIComponent(chapterId)}/translation?lang=${lang}`, { signal }),
  /** Whether this reader may show translations, and which service makes them. */
  translationSettings: () => request<TranslationSettings>("/api/translation"),
  /** Whether this reader gets the button that opens a deep dive in an outside chat (Open in ChatGPT). */
  handoffSettings: () => request<HandoffSettings>("/api/handoff"),
  adminHandoff: () => request<HandoffSettings>("/api/admin/handoff"),
  saveAdminHandoff: (patch: Partial<HandoffSettings>) => request<HandoffSettings>("/api/admin/handoff", json("PUT", patch)),
  adminTranslation: () => request<TranslationSettings>("/api/admin/translation"),
  saveAdminTranslation: (patch: Partial<TranslationSettings>) => request<TranslationSettings>("/api/admin/translation", json("PUT", patch)),
  /** Translates one sample sentence with the chosen service, so the admin sees it work. */
  testAdminTranslation: (lang: LangCode) => request<TranslationTest>("/api/admin/translation/test", json("POST", { lang })),
};

const CUT_OFF = "The answer stopped before it was finished.";

/**
 * POST to a streaming AI route and report the text as it grows.
 * Resolves with the full text once the server says it is done; rejects if the server reports an error
 * mid-stream, or if the stream ends or breaks without that word, so a half answer never passes for a whole one.
 */
export async function streamText(
  path: string,
  body: unknown,
  onText: (textSoFar: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await accept(path, { ...json("POST", body), signal });
  if (!res.body) throw new ApiFailure("no_stream", "The server sent an empty answer.", 502);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read().catch((error: unknown) => {
      // A lost connection (the server stopped, the network dropped) reads as the browser's bare "network error".
      if (signal?.aborted) throw error;
      throw new ApiFailure("cut_off", CUT_OFF, 502);
    });
    if (done) throw new ApiFailure("cut_off", CUT_OFF, 502);
    buffer += value.replaceAll("\r\n", "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
      }
      if (event === "delta") {
        text += (JSON.parse(data) as { text: string }).text;
        onText(text);
      } else if (event === "error") {
        throw new ApiFailure("ai_failed", (JSON.parse(data) as { message: string }).message, 502);
      } else if (event === "done") {
        return text;
      }
    }
  }
}
