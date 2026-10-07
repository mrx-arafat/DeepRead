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
import { isReadableBookId } from "./shares.ts";
import type { Library } from "./library.ts";
import type { Ai, AiAccess } from "./ai.ts";
import { isAiProviderId } from "./ai.ts";
import type { Accounts } from "./deps.ts";
import type { StoredProfile } from "./profiles.ts";
import { completeText, LlmError } from "./llm.ts";
import type { Llm } from "./llm.ts";
import { askPrompt, chapterAidPrompt, checkClosing, closingPrompt, explainPrompt } from "./prompts.ts";
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
const CLOSING_RETRY_HINT =
  "\n\nYour last reply broke a rule. Reply with only the one or two plain sentences asked for: no praise, no exclamation marks, no markdown, at most 45 words, and the word \"you\" in it.";
const OPENING_WORDS = 120;

// A Record type makes this list exhaustive: adding a kind to the contract fails to compile until handled here.
const AID_KINDS: Record<ChapterAidKind, true> = { preview: true, recap: true, quiz: true, closing: true };

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

/** Asks for the closing line, and once more if the reply breaks a rule; null means both replies were unusable. */
async function generateClosing(llm: Llm, prompt: Prompt, hasNext: boolean, signal: AbortSignal): Promise<string | null> {
  for (const hint of ["", CLOSING_RETRY_HINT]) {
    const reply = await completeText(llm, { task: "closing", system: prompt.system, user: prompt.user + hint, signal });
    const text = checkClosing(reply, { hasNext });
    if (text) return text;
    // Kept in the log, so a rule that refuses good lines can be seen and loosened.
    console.warn("closing line refused:", JSON.stringify(reply.slice(0, 400)));
  }
  return null;
}

type Located = { book: ParsedBook; chapter: Chapter };

/** The book's own chapters, as opposed to the front and back matter around them; books parsed before sections had kinds are all body. */
const isMainChapter = (chapter: Chapter): boolean => (chapter.kind ?? "body") === "body";

/** The first words of a chapter's text, enough to tell the model what it opens on. */
function openingOf(chapter: Chapter): string {
  const words: string[] = [];
  for (const block of chapter.blocks) {
    if (block.type === "paragraph") words.push(...block.text.split(/\s+/, OPENING_WORDS + 1 - words.length).filter(Boolean));
    if (words.length > OPENING_WORDS) break;
  }
  const opening = words.slice(0, OPENING_WORDS).join(" ");
  return words.length > OPENING_WORDS ? `${opening} ...` : opening;
}

/** Finds the book and chapter named in a request body, or the 4xx response to send instead. */
async function locate(c: Context, library: Library, bookId: string, chapterId: string): Promise<Located | Response> {
  if (!isReadableBookId(bookId)) return invalidId(c);
  const book = await library.book(bookId);
  if (!book) return bookNotFound(c);
  const chapter = book.chapters.find((candidate) => candidate.id === chapterId);
  return chapter ? { book, chapter } : chapterNotFound(c);
}

/** What a profile may use: the admin's own, anything that works; every other, only what the admin gave them. */
export function accessOf(profile: StoredProfile): AiAccess {
  return {
    allowed: profile.admin ? "all" : (profile.aiAccess ?? []),
    choice: profile.aiChoice ?? null,
    requested: Object.keys(profile.aiRequests ?? {}).filter(isAiProviderId),
    reader: profile.id,
  };
}

/**
 * The closing line at the end of a main chapter. It arrives whole like the quiz: a line that breaks a rule is asked for once more,
 * and only a line that passes is cached or sent.
 */
async function closingAid(c: Context, library: Library, helper: Llm, bookId: string, { book, chapter }: Located, refresh: boolean): Promise<Response> {
  const main = book.chapters.filter(isMainChapter);
  const at = main.findIndex((candidate) => candidate.id === chapter.id);
  if (at < 0) return invalidBody(c, "a closing line is only written for a main chapter, not for the matter before or after the book.");
  const next = main[at + 1];
  const prompt = closingPrompt({
    bookTitle: book.title,
    chapterTitle: chapter.title,
    chapterText: buildChapterText(chapter.blocks),
    author: book.author,
    next: next ? { title: next.title, opening: openingOf(next) } : null,
    shapeIndex: at,
  });
  const hasNext = next !== undefined;
  // The line is always English, so every reader language shares one cached answer.
  const key = cacheKey({ task: "closing", lang: "en", chapterId: chapter.id, model: helper.model("closing"), prompt });

  if (!refresh) {
    const hit = await library.readCache(bookId, key);
    const cached = isRecord(hit) && typeof hit.text === "string" ? checkClosing(hit.text, { hasNext }) : null;
    if (cached) return c.json({ kind: "closing", text: cached } satisfies ChapterAid);
  }
  try {
    const text = await generateClosing(helper, prompt, hasNext, c.req.raw.signal);
    if (!text) return apiError(c, 502, "closing_invalid", "The AI did not produce a usable closing line. Please try again.");
    await library.writeCache(bookId, key, { text });
    return c.json({ kind: "closing", text } satisfies ChapterAid);
  } catch (error) {
    if (error instanceof LlmError) return modelFailure(c, error);
    throw error;
  }
}

/**
 * The answers are cached with the book, in c.var.library: the books of whoever is reading.
 * With profiles, each reader's questions are answered by a helper the admin gave them, and by no other: this is the one place
 * that decides it, so the picker the reader sees only shows what is decided here.
 */
export function aiRoutes(deps: { llm: Ai; accounts?: Accounts }): Hono<AppEnv> {
  const { llm, accounts } = deps;
  const routes = new Hono<AppEnv>();

  /** The admin's name, so a reader is told whose helper they are using. */
  async function ownerName(): Promise<string | undefined> {
    return accounts ? (await accounts.profiles.list()).find((profile) => profile.admin)?.name : undefined;
  }

  /** The helper that answers whoever is reading: the one for everyone without profiles, else the one the admin gave them. */
  async function helperFor(c: Context<AppEnv>): Promise<Llm> {
    const { session } = c.var;
    if (!session) return llm;
    await llm.ensureStatus();
    return llm.for(accessOf(session.profile));
  }

  routes.use(
    "*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => invalidBody(c, "the request body is too large.") }),
  );

  routes.post("/explain", async (c) => {
    const { library } = c.var;
    const helper = await helperFor(c);
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
      model: helper.model(task),
      prompt,
    });
    return answerStream(c, library, {
      bookId,
      cacheKey: key,
      refresh: false,
      generate: (signal) => helper.streamText({ task, ...prompt, signal }),
    });
  });

  routes.post("/chapter", async (c) => {
    const { library } = c.var;
    const helper = await helperFor(c);
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
    if (kind === "closing") return closingAid(c, library, helper, bookId, found, refresh);

    const prompt = chapterAidPrompt(kind, {
      bookTitle: book.title,
      chapterTitle: chapter.title,
      chapterText: buildChapterText(chapter.blocks),
      language: LANGUAGES[lang],
    });
    const key = cacheKey({ task: kind, lang, chapterId, model: helper.model(kind), prompt });

    if (kind !== "quiz") {
      return answerStream(c, library, {
        bookId,
        cacheKey: key,
        refresh,
        generate: (signal) => helper.streamText({ task: kind, ...prompt, signal }),
      });
    }

    if (!refresh) {
      const hit = await library.readCache(bookId, key);
      const questions = isRecord(hit) ? validateQuiz(hit.questions) : null;
      if (questions) return c.json({ kind: "quiz", questions } satisfies ChapterAid);
    }
    try {
      const questions = await generateQuiz(helper, prompt, c.req.raw.signal);
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
    const helper = await helperFor(c);
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
      generate: (signal) => helper.streamText({ task: "ask", ...prompt, signal }),
    });
  });

  routes.get("/providers", async (c) => {
    const { session } = c.var;
    // With profiles each reader sees every helper in the state it is in for them: theirs, asked for, or the admin's to give.
    return c.json(session ? { ...(await llm.statusFor(accessOf(session.profile))), owner: await ownerName() } : await llm.status());
  });

  routes.put("/provider", async (c) => {
    const { session } = c.var;
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, "send a JSON object.");
    const { id } = body;
    if (!isAiProviderId(id)) {
      return apiError(c, 400, "invalid_provider", `Unknown AI helper. Pick one of: ${Object.keys(AI_PROVIDERS).join(", ")}.`);
    }
    if (!session || !accounts) {
      try {
        return c.json(await llm.choose(id));
      } catch (error) {
        if (error instanceof LlmError) return apiError(c, 409, "ai_not_installed", error.message);
        throw error;
      }
    }
    // With profiles a reader picks among the helpers the admin gave them, for themselves.
    const access = accessOf(session.profile);
    const provider = (await llm.statusFor(access)).providers.find((one) => one.id === id);
    if (!provider?.allowed) {
      return apiError(c, 403, "ai_not_allowed", `The admin has not given you ${AI_PROVIDERS[id]}. Ask them for it.`);
    }
    if (!provider.installed) {
      return apiError(c, 409, "ai_not_installed", `${AI_PROVIDERS[id]} is not available on this server right now.`);
    }
    await accounts.profiles.setAiChoice(session.profile.id, id);
    return c.json({ ...(await llm.statusFor({ ...access, choice: id })), owner: await ownerName() });
  });

  // A reader asks the admin for a helper they were not given. Only what this server can answer with can be asked for.
  routes.post("/request", async (c) => {
    const { session } = c.var;
    if (!session || !accounts) return apiError(c, 404, "not_found", "Asking the admin needs profiles: without them there is no admin to ask.");
    const body = await readJsonObject(c);
    if (!body) return invalidBody(c, "send JSON like {\"id\": \"claude\"}.");
    const { id } = body;
    if (!isAiProviderId(id)) {
      return apiError(c, 400, "invalid_provider", `Unknown AI helper. Pick one of: ${Object.keys(AI_PROVIDERS).join(", ")}.`);
    }
    const access = accessOf(session.profile);
    const provider = (await llm.statusFor(access)).providers.find((one) => one.id === id);
    if (provider?.allowed) return c.json({ ...(await llm.statusFor(access)), owner: await ownerName() });
    if (!provider?.installed) {
      return apiError(c, 409, "ai_not_installed", `${AI_PROVIDERS[id]} is not set up on this server, so the admin has nothing to give you yet.`);
    }
    const updated = await accounts.profiles.requestAi(session.profile.id, id);
    if (!updated) return apiError(c, 404, "not_found", "That profile no longer exists.");
    return c.json({ ...(await llm.statusFor(accessOf(updated))), owner: await ownerName() });
  });

  return routes;
}
