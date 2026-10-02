import type {
  AiProviderId,
  AiStatus,
  ApiError,
  BookDetail,
  BookSummary,
  BookUpdate,
  Chapter,
  LangCode,
  QuickTranslation,
  ReadingProgress,
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

/** The response of a request DeepRead answered with success; anything else throws an ApiFailure. */
async function accept(path: string, init?: RequestInit): Promise<Response> {
  const res = await connect(path, init);
  if (!res.ok) throw await failure(res);
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

export const api = {
  listBooks: () => request<BookSummary[]>("/api/books"),
  getBook: (id: string) => request<BookDetail>(`/api/books/${id}`),
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
  saveProgress: (bookId: string, chapterId: string, blockId: string) =>
    request<ReadingProgress>(`/api/books/${bookId}/progress`, json("PUT", { chapterId, blockId })),
  translate: (text: string, lang: LangCode, signal?: AbortSignal) =>
    request<QuickTranslation>(
      `/api/translate?q=${encodeURIComponent(text)}&lang=${lang}`,
      { signal },
    ),
  aiStatus: () => request<AiStatus>("/api/ai/providers"),
  chooseAi: (id: AiProviderId) => request<AiStatus>("/api/ai/provider", json("PUT", { id })),
};

/**
 * POST to a streaming AI route and report the text as it grows.
 * Resolves with the full text; rejects if the server reports an error mid-stream.
 */
export async function streamText(
  path: string,
  body: unknown,
  onText: (textSoFar: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(path, { ...json("POST", body), signal });
  if (!res.ok) throw await failure(res);
  if (!res.body) throw new ApiFailure("no_stream", "The server sent an empty answer.", 502);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
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
  return text;
}
