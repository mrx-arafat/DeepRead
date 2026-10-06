import type { NoteChange } from "../shared/notes.ts";
import type {
  AdminProfile,
  AiProviderId,
  AiStatus,
  ApiError,
  BookDetail,
  BookSummary,
  BookUpdate,
  Chapter,
  LangCode,
  NewProfile,
  Note,
  ProfileUpdate,
  PublicProfile,
  QuickTranslation,
  ReadingProgress,
  Session,
  SessionInfo,
  StorageUsage,
} from "../shared/types.ts";

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

const NOT_REACHABLE = "DeepRead is not reachable. Check that it is running, then try again.";

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

/** The response of a request DeepRead answered with success; anything else throws an ApiFailure. */
async function accept(path: string, init?: RequestInit): Promise<Response> {
  const res = await connect(path, init);
  if (!res.ok) {
    const error = await failure(res);
    if (error.code === "sign_in_required") window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    throw error;
  }
  return res;
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

// The newest progress save still on its way. The shelf and a book wait for it (two seconds at most, and whatever its
// outcome), so what they say of the reader's place is never the one before the place they have just left.
let saving: Promise<unknown> = Promise.resolve();
const SAVE_WAIT_MS = 2000;

async function afterSaving(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([saving, new Promise((resolve) => (timer = setTimeout(resolve, SAVE_WAIT_MS)))]);
  clearTimeout(timer);
}

export const api = {
  listBooks: async () => {
    await afterSaving();
    return request<BookSummary[]>("/api/books");
  },
  getBook: async (id: string) => {
    await afterSaving();
    return request<BookDetail>(`/api/books/${id}`);
  },
  updateBook: (id: string, update: BookUpdate) => request<BookDetail>(`/api/books/${id}`, json("PATCH", update)),
  deleteBook: (id: string) => request<void>(`/api/books/${id}`, { method: "DELETE" }),
  getChapter: (bookId: string, chapterId: string, signal?: AbortSignal) =>
    request<Chapter>(`/api/books/${bookId}/chapters/${chapterId}`, { signal }),
  uploadBook: async (file: File): Promise<{ book: BookDetail; alreadyHad: boolean }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await accept("/api/books", { method: "POST", body: form });
    // 201 is a new book; 200 means this exact file is already in the library and nothing was added.
    return { book: (await res.json()) as BookDetail, alreadyHad: res.status === 200 };
  },
  saveProgress: (bookId: string, chapterId: string, blockId: string, offset: number) => {
    // `keepalive`: the save made as the page closes is still delivered.
    const done = request<ReadingProgress>(`/api/books/${bookId}/progress`, { ...json("PUT", { chapterId, blockId, offset }), keepalive: true });
    saving = done.catch(() => {});
    return done;
  },
  getNotes: (bookId: string) => request<Note[]>(`/api/books/${bookId}/notes`),
  changeNote: (bookId: string, change: NoteChange) =>
    change.kind === "put"
      ? request<void>(`/api/books/${bookId}/notes/${encodeURIComponent(change.note.id)}`, json("PUT", { note: change.note, before: change.before }))
      : request<void>(`/api/books/${bookId}/notes/${encodeURIComponent(change.id)}`, { method: "DELETE" }),
  storage: () => request<StorageUsage>("/api/storage"),

  session: () => request<SessionInfo>("/api/session"),
  profiles: () => request<PublicProfile[]>("/api/profiles"),
  /** Signs in for 30 days. Rejects with code "wrong_code" (401) or "too_many_tries" (429). */
  signIn: (profileId: string, code: string) => request<Session>("/api/session", json("POST", { profileId, code })),
  signOut: () => request<void>("/api/session", { method: "DELETE" }),

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
  impersonate: (id: string) => request<Session>(`/api/admin/impersonate/${id}`, { method: "POST" }),
  stopImpersonating: () => request<Session>("/api/admin/impersonate", { method: "DELETE" }),
  translate: (text: string, lang: LangCode, signal?: AbortSignal) =>
    request<QuickTranslation>(
      `/api/translate?q=${encodeURIComponent(text)}&lang=${lang}`,
      { signal },
    ),
  aiStatus: () => request<AiStatus>("/api/ai/providers"),
  chooseAi: (id: AiProviderId) => request<AiStatus>("/api/ai/provider", json("PUT", { id })),
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
