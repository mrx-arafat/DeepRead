import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { AI_PROVIDERS, LANGUAGES } from "../shared/types.ts";
import type {
  AskRequest,
  Chapter,
  ChapterAid,
  ChapterAidKind,
  ParsedBook,
  QuizQuestion,
} from "../shared/types.ts";
import { buildChapterText, buildPassage, cacheKey } from "./ai-inputs.ts";
import type { AppEnv } from "./app-env.ts";
import {
  adminOnly,
  apiError,
  blockNotFound,
  bookNotFound,
  chapterNotFound,
  EXPLAIN_MODES,
  invalidBody,
  invalidId,
  isExplainMode,
  isLangCode,
  isRecord,
  LANG_HELP,
  readJsonObject,
  readString,
} from "./http.ts";
import { isBookId } from "./library.ts";
import type { Library } from "./library.ts";
import type { Ai } from "./ai.ts";
import { isAiProviderId } from "./ai.ts";
import { completeText, LlmError } from "./llm.ts";
import type { Llm } from "./llm.ts";
import { askPrompt, chapterAidPrompt, explainPrompt } from "./prompts.ts";
import type { Prompt } from "./prompts.ts";
import { parseQuiz, validateQuiz } from "./quiz.ts";

const MAX_ID_FIELD = 200;
const MAX_SELECTION_CHARS = 5_000;
const MAX_QUESTION_CHARS = 4_000;
const MAX_TURN_CHARS = 10_000;
const MAX_HISTORY_TURNS = 20;
const MAX_BODY_BYTES = 1024 * 1024;
const QUIZ_RETRY_HINT =
  "\n\nYour last reply could not be read. Reply with only the JSON array: no code fences, no other text.";

// A Record type makes this list exhaustive: adding a kind to the contract fails to compile until handled here.
const AID_KINDS: Record<ChapterAidKind, true> = { preview: true, recap: true, quiz: true };

const isAidKind = (value: unknown): value is ChapterAidKind =>
  typeof value === "string" && Object.hasOwn(AID_KINDS, value);

function parseHistory(value: unknown): AskRequest["history"] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const turns: AskRequest["history"] = [];
  for (const item of value) {
    if (!isRecord(item) || (item.role !== "user" && item.role !== "assistant")) return null;
    if (typeof item.text !== "string" || item.text.length > MAX_TURN_CHARS) return null;
    turns.push({ role: item.role, text: item.text });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

/** Maps a model failure to an HTTP answer for the one route that replies in JSON instead of SSE. */
function modelFailure(c: Context, error: LlmError): Response {
  if (error.kind === "aborted") return c.body(null, 204);
  if (error.kind === "timeout") return apiError(c, 504, "ai_timeout", error.message);
  if (error.kind === "failed") return apiError(c, 502, "ai_failed", error.message);
  return apiError(c, 503, "ai_unavailable", error.message);
}

type StreamPlan = {
  bookId: string;
  /** null means the answer is never cached (follow-up questions depend on the conversation). */
  cacheKey: string | null;
  /** Skip reading the cache; a successful new answer still overwrites it. */
  refresh: boolean;
  generate: (signal: AbortSignal) => AsyncIterable<string>;
};

/** Server-sent events: `delta` {text} repeatedly, then exactly one `done` {cached} or `error` {message}. */
function answerStream(c: Context, library: Library, plan: StreamPlan): Response {
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    // The reader navigated away or closed the tab: stop paying for an answer nobody will read.
    stream.onAbort(() => abort.abort());
    if (stream.aborted) abort.abort();
    const send = (event: "delta" | "done" | "error", data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) });

    if (plan.cacheKey && !plan.refresh) {
      const hit = await library.readCache(plan.bookId, plan.cacheKey);
      if (isRecord(hit) && typeof hit.text === "string" && hit.text !== "") {
        await send("delta", { text: hit.text });
        await send("done", { cached: true });
        return;
      }
    }

    let text = "";
    try {
      for await (const piece of plan.generate(abort.signal)) {
        text += piece;
        await send("delta", { text: piece });
      }
      if (text.trim() === "") {
        throw new LlmError("failed", "The AI sent back an empty answer. Please try again.");
      }
    } catch (error) {
      // Nothing is cached on this path: a failed or abandoned answer must never be served again.
      if (abort.signal.aborted) return;
      let message = "Something went wrong while the AI was answering. Please try again.";
      if (error instanceof LlmError) message = error.message;
      else console.error("unexpected error while streaming an answer:", error);
      await send("error", { message });
      return;
    }

    // Cache before announcing `done`, so a request sent the moment `done` arrives already hits it.
    if (plan.cacheKey && !abort.signal.aborted) await library.writeCache(plan.bookId, plan.cacheKey, { text });
    await send("done", { cached: false });
  });
}

/** Asks for the quiz, and once more if the reply is not valid; null means both replies were unusable. */
async function generateQuiz(llm: Llm, prompt: Prompt, signal: AbortSignal): Promise<QuizQuestion[] | null> {
  for (const hint of ["", QUIZ_RETRY_HINT]) {
    const reply = await completeText(llm, { task: "quiz", system: prompt.system, user: prompt.user + hint, signal });
    const questions = parseQuiz(reply);
    if (questions) return questions;
  }
  return null;
}

type Located = { book: ParsedBook; chapter: Chapter };

/** Finds the book and chapter named in a request body, or the 4xx response to send instead. */
async function locate(c: Context, library: Library, bookId: string, chapterId: string): Promise<Located | Response> {
  if (!isBookId(bookId)) return invalidId(c);
  const book = await library.book(bookId);
  if (!book) return bookNotFound(c);
  const chapter = book.chapters.find((candidate) => candidate.id === chapterId);
  return chapter ? { book, chapter } : chapterNotFound(c);
}

/** The answers are cached with the book, in c.var.library: the books of whoever is reading. */
export function aiRoutes(deps: { llm: Ai }): Hono<AppEnv> {
  const { llm } = deps;
  const routes = new Hono<AppEnv>();

  routes.use(
    "*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => invalidBody(c, "the request body is too large.") }),
  );

  routes.post("/explain", async (c) => {
    const { library } = c.var;
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, "send a JSON object.");
    const bookId = readString(body, "bookId", MAX_ID_FIELD);
    const chapterId = readString(body, "chapterId", MAX_ID_FIELD);
    const blockId = readString(body, "blockId", MAX_ID_FIELD);
    const selection = readString(body, "selection", MAX_SELECTION_CHARS);
    if (!bookId || !chapterId || !blockId || !selection) {
      return invalidBody(c, "bookId, chapterId, blockId and a non-empty selection are required.");
    }
    const { mode, lang } = body;
    if (!isExplainMode(mode)) {
      return apiError(c, 400, "invalid_mode", `Unknown mode. Pick one of: ${Object.keys(EXPLAIN_MODES).join(", ")}.`);
    }
    if (!isLangCode(lang)) return apiError(c, 400, "invalid_lang", LANG_HELP);

    const found = await locate(c, library, bookId, chapterId);
    if (found instanceof Response) return found;
    const { book, chapter } = found;
    const at = chapter.blocks.findIndex((block) => block.id === blockId);
    const current = chapter.blocks[at];
    if (!current) return blockNotFound(c);

    const prompt = explainPrompt(mode, {
      bookTitle: book.title,
      chapterTitle: chapter.title,
      passage: buildPassage(chapter.blocks, at),
      selection,
      language: LANGUAGES[lang],
    });
    const task = mode === "word" ? "word" : "explain";
    const key = cacheKey({
      task,
      mode,
      lang,
      chapterId,
      blockId,
      selection,
      model: llm.model(task),
      prompt,
    });
    return answerStream(c, library, {
      bookId,
      cacheKey: key,
      refresh: false,
      generate: (signal) => llm.streamText({ task, ...prompt, signal }),
    });
  });

  routes.post("/chapter", async (c) => {
    const { library } = c.var;
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, "send a JSON object.");
    const bookId = readString(body, "bookId", MAX_ID_FIELD);
    const chapterId = readString(body, "chapterId", MAX_ID_FIELD);
    if (!bookId || !chapterId) return invalidBody(c, "bookId and chapterId are required.");
    const { kind, lang, refresh = false } = body;
    if (!isAidKind(kind)) {
      return apiError(c, 400, "invalid_kind", `Unknown kind. Pick one of: ${Object.keys(AID_KINDS).join(", ")}.`);
    }
    if (!isLangCode(lang)) return apiError(c, 400, "invalid_lang", LANG_HELP);
    if (typeof refresh !== "boolean") return invalidBody(c, "refresh must be true or false.");

    const found = await locate(c, library, bookId, chapterId);
    if (found instanceof Response) return found;
    const { book, chapter } = found;

    const prompt = chapterAidPrompt(kind, {
      bookTitle: book.title,
      chapterTitle: chapter.title,
      chapterText: buildChapterText(chapter.blocks),
      language: LANGUAGES[lang],
    });
    const key = cacheKey({ task: kind, lang, chapterId, model: llm.model(kind), prompt });

    if (kind !== "quiz") {
      return answerStream(c, library, {
        bookId,
        cacheKey: key,
        refresh,
        generate: (signal) => llm.streamText({ task: kind, ...prompt, signal }),
      });
    }

    if (!refresh) {
      const hit = await library.readCache(bookId, key);
      const questions = isRecord(hit) ? validateQuiz(hit.questions) : null;
      if (questions) return c.json({ kind: "quiz", questions } satisfies ChapterAid);
    }
    try {
      const questions = await generateQuiz(llm, prompt, c.req.raw.signal);
      if (!questions) {
        return apiError(c, 502, "quiz_invalid", "The AI did not produce a usable quiz. Please try again.");
      }
      await library.writeCache(bookId, key, { questions });
      return c.json({ kind: "quiz", questions } satisfies ChapterAid);
    } catch (error) {
      if (error instanceof LlmError) return modelFailure(c, error);
      throw error;
    }
  });

  routes.post("/ask", async (c) => {
    const { library } = c.var;
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, "send a JSON object.");
    const bookId = readString(body, "bookId", MAX_ID_FIELD);
    const chapterId = readString(body, "chapterId", MAX_ID_FIELD);
    const question = readString(body, "question", MAX_QUESTION_CHARS);
    if (!bookId || !chapterId || !question) {
      return invalidBody(c, "bookId, chapterId and a non-empty question are required.");
    }
    const history = parseHistory(body.history);
    if (!history) {
      return invalidBody(c, "history must be a list of {role: \"user\" | \"assistant\", text} turns.");
    }
    const { lang } = body;
    if (!isLangCode(lang)) return apiError(c, 400, "invalid_lang", LANG_HELP);

    const found = await locate(c, library, bookId, chapterId);
    if (found instanceof Response) return found;
    const { book, chapter } = found;

    const prompt = askPrompt(
      {
        bookTitle: book.title,
        chapterTitle: chapter.title,
        chapterText: buildChapterText(chapter.blocks),
        language: LANGUAGES[lang],
      },
      history,
      question,
    );
    return answerStream(c, library, {
      bookId,
      cacheKey: null,
      refresh: false,
      generate: (signal) => llm.streamText({ task: "ask", ...prompt, signal }),
    });
  });

  routes.get("/providers", async (c) => c.json(await llm.status()));

  routes.put("/provider", async (c) => {
    // One AI helper answers for every profile, so with profiles only the admin picks it (also while viewing as someone).
    const { session } = c.var;
    if (session && !session.actor.admin) return adminOnly(c);
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, "send a JSON object.");
    const { id } = body;
    if (!isAiProviderId(id)) {
      return apiError(c, 400, "invalid_provider", `Unknown AI helper. Pick one of: ${Object.keys(AI_PROVIDERS).join(", ")}.`);
    }
    try {
      return c.json(await llm.choose(id));
    } catch (error) {
      if (error instanceof LlmError) return apiError(c, 409, "ai_not_installed", error.message);
      throw error;
    }
  });

  return routes;
}
