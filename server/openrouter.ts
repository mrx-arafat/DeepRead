// OpenRouter as an AI helper: one API key and one model, which the admin chooses, answer for every reader. It is the
// helper that needs nothing on the reader's computer, so a reader with no Claude Code or Codex still gets explanations.
// The key comes from OPENROUTER_API_KEY in .env, or from the admin page, which wins; the model likewise from
// OPENROUTER_MODEL. What the admin saves is kept in <dataDir>/openrouter.json, readable by its owner only, and the key
// is never sent to a browser: the admin page is told only its last four characters. Beside it, openrouter-usage.json holds
// each reader's count of requests today (reader ids and numbers only), so the daily limit survives a restart.
// Like the command-line helpers it gives the model no tools, so text in a book cannot make it act on anything.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OpenRouterModel, OpenRouterPatch, OpenRouterTest, OpenRouterView } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { createGate, LlmError, TASK_PROFILES } from "./llm.ts";
import type { Llm, LlmRequest, LlmTask } from "./llm.ts";

const API = "https://openrouter.ai/api/v1";
const MODELS_KEPT_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = 4;
const TEST_TIMEOUT_MS = 30_000;
const KEY_SHAPE = /^sk-or-[A-Za-z0-9_-]{16,200}$/;
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const KEY_IN_TEXT = /sk-or-[A-Za-z0-9_-]{8,}/g;

/** The longest each kind of answer may run to: a word card is short, a quiz is the longest. It also caps what a runaway model can cost. */
const MAX_TOKENS: Record<LlmTask, number> = { word: 900, explain: 1800, ask: 1800, preview: 2600, recap: 2600, quiz: 3400, closing: 300 };

export type OpenRouterErrorCode = "invalid_key" | "invalid_model" | "unknown_model" | "invalid_limit" | "models_unavailable";

/** A change the rules do not allow, such as a model OpenRouter does not list. The message says what to do instead. */
export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;

  constructor(code: OpenRouterErrorCode, message: string) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
  }
}

export type OpenRouter = Llm & {
  describe(): Promise<OpenRouterView>;
  /** Whether it can answer now: a key and a model are both set. */
  available(): Promise<boolean>;
  /** Throws OpenRouterError for a key or model that is not acceptable. */
  save(patch: OpenRouterPatch): Promise<OpenRouterView>;
  /** What OpenRouter offers. Throws OpenRouterError when the list cannot be had. */
  models(): Promise<OpenRouterModel[]>;
  /** Asks the model for one word, to show the admin whether the key and the model work. */
  test(): Promise<OpenRouterTest>;
  /** Counts a request by `reader` against their day, or throws LlmError once they have used all of it. */
  admit(reader: string): void;
  /** What the key has spent and may spend, kept for a minute; null with no key, or when OpenRouter cannot say. */
  balance(): Promise<{ used: number; limit: number | null } | null>;
};

export type OpenRouterOptions = {
  /** Where the admin's saved key and model are kept. */
  dataDir: string;
  /** Read at each use, not once. Defaults to the process's environment. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** The clock, for tests of when a day ends. */
  now?: () => number;
  /** How long to wait before each new try when a provider is briefly busy. */
  retryDelaysMs?: readonly number[];
};

/** A busy or failing provider behind OpenRouter often answers on the next try, from another one. Nothing else is worth trying again. */
const RETRY_STATUSES = new Set([429, 502, 503]);
const RETRY_DELAYS_MS = [400, 1_200] as const;

/** A reader's requests a day when neither the admin nor .env says: enough to read a good deal, far from a runaway. */
const DEFAULT_DAILY_LIMIT = 100;
const MAX_DAILY_LIMIT = 100_000;

type Saved = { apiKey?: string; model?: string; dailyLimit?: number };

function readSaved(file: string): Saved {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const { apiKey, model, dailyLimit } = parsed as Record<string, unknown>;
    return {
      ...(typeof apiKey === "string" && apiKey !== "" && { apiKey }),
      ...(typeof model === "string" && model !== "" && { model }),
      ...(isLimit(dailyLimit) && { dailyLimit }),
    };
  } catch {
    return {};
  }
}

const isLimit = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DAILY_LIMIT;

/** The day's counts as the last run left them. A file that is missing, unreadable or makes no sense is a day with no requests yet. */
function readUsage(file: string): { day: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { day: "", counts };
    const { day, counts: kept } = parsed as Record<string, unknown>;
    if (typeof day !== "string" || typeof kept !== "object" || kept === null) return { day: "", counts };
    for (const [reader, count] of Object.entries(kept)) {
      if (typeof count === "number" && Number.isInteger(count) && count > 0) counts.set(reader, count);
    }
    return { day, counts };
  } catch {
    return { day: "", counts: new Map() };
  }
}

const redact = (text: string): string => text.replace(KEY_IN_TEXT, "[key]");

/** The text of one `data:` line at a time from a server-sent event stream; comments and blank lines are skipped. */
async function* dataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
        const event = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data !== "") yield data;
      }
      if (done) break;
    }
    const rest = pending
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (rest !== "") yield rest;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function messageOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed: unknown = JSON.parse(text);
    const message = typeof parsed === "object" && parsed !== null ? (parsed as { error?: { message?: unknown } }).error?.message : undefined;
    if (typeof message === "string" && message !== "") return redact(message);
  } catch {
    // Not JSON: a proxy's page, say. A short piece of it is still better than nothing.
  }
  return redact(text.replace(/\s+/g, " ").trim().slice(0, 200));
}

export function createOpenRouter(options: OpenRouterOptions): OpenRouter {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const file = join(options.dataDir, "openrouter.json");
  // Only this process writes the file, so what is in memory is what is on disk: `model` can answer without waiting for a read.
  let saved = readSaved(file);
  const gate = createGate(MAX_CONCURRENT);
  const now = options.now ?? Date.now;
  const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  // Each reader's requests today are kept in <dataDir>/openrouter-usage.json, so a restart does not give anyone a fresh day.
  // What was kept for an earlier day is dropped by the first look at today.
  // SHORTCUT: one server counts for the data folder; two sharing it each count alone and the last write wins. Count in a
  // shared store if a second server is ever pointed at one folder.
  const usageFile = join(options.dataDir, "openrouter-usage.json");
  const stored = readUsage(usageFile);
  let day = stored.day;
  const usedToday = stored.counts;
  const today = (): Map<string, number> => {
    const date = new Date(now()).toISOString().slice(0, 10);
    if (date !== day) {
      day = date;
      usedToday.clear();
    }
    return usedToday;
  };
  // Writes go one at a time, so a slow disk cannot let an older count land last. They never wait on a request: the count in
  // memory is what admit() goes by.
  let writing = Promise.resolve();
  let waiting = false;
  const persist = (): void => {
    // A write already waiting for its turn will carry this count too.
    if (waiting) return;
    waiting = true;
    writing = writing.then(async () => {
      waiting = false;
      const body = `${JSON.stringify({ day, counts: Object.fromEntries(usedToday) })}\n`;
      try {
        await mkdir(options.dataDir, { recursive: true });
        await writeFileAtomic(usageFile, body);
      } catch (error) {
        console.warn(`DeepRead could not save today's count of API model requests: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };
  let listing: { at: number; models: OpenRouterModel[] } | null = null;

  function resolved() {
    const fromEnv = (name: string) => env[name]?.trim() || null;
    const apiKey = saved.apiKey ?? fromEnv("OPENROUTER_API_KEY");
    const model = saved.model ?? fromEnv("OPENROUTER_MODEL");
    const envLimit = Number(fromEnv("OPENROUTER_DAILY_LIMIT") ?? Number.NaN);
    return {
      dailyLimit: saved.dailyLimit ?? (isLimit(envLimit) ? envLimit : DEFAULT_DAILY_LIMIT),
      apiKey,
      keySource: saved.apiKey ? ("admin" as const) : apiKey ? ("env" as const) : null,
      model,
      modelSource: saved.model ? ("admin" as const) : model ? ("env" as const) : null,
    };
  }

  async function describe(): Promise<OpenRouterView> {
    const { apiKey, keySource, model, modelSource, dailyLimit } = resolved();
    return {
      keySet: apiKey !== null,
      keySource,
      keyHint: apiKey ? apiKey.slice(-4) : null,
      model,
      modelSource,
      dailyLimit,
      usedToday: Object.fromEntries(today()),
    };
  }

  async function models(): Promise<OpenRouterModel[]> {
    if (listing && Date.now() - listing.at < MODELS_KEPT_MS) return listing.models;
    try {
      // The list is public, so no key goes with the request.
      const response = await doFetch(`${API}/models`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
      const price = (value: unknown): number | null => {
        const perToken = Number(value);
        return Number.isFinite(perToken) && perToken >= 0 ? Number((perToken * 1e6).toFixed(4)) : null;
      };
      const found = (body.data ?? [])
        .filter((model) => typeof model.id === "string")
        .map((model): OpenRouterModel => {
          const pricing = (model.pricing ?? {}) as Record<string, unknown>;
          const promptPerMillion = price(pricing.prompt);
          const completionPerMillion = price(pricing.completion);
          return {
            id: String(model.id),
            name: typeof model.name === "string" ? model.name : String(model.id),
            free: promptPerMillion === 0 && completionPerMillion === 0,
            promptPerMillion,
            completionPerMillion,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      listing = { at: Date.now(), models: found };
      return found;
    } catch (error) {
      // An old list is better than none when OpenRouter cannot be reached for a moment.
      if (listing) return listing.models;
      throw new OpenRouterError("models_unavailable", `The list of OpenRouter models could not be had: ${error instanceof Error ? error.message : "unknown error"}.`);
    }
  }

  async function save(patch: OpenRouterPatch): Promise<OpenRouterView> {
    const next: Saved = { ...saved };
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey === null ? null : patch.apiKey.trim();
      if (key !== null && !KEY_SHAPE.test(key)) {
        throw new OpenRouterError("invalid_key", "That is not an OpenRouter API key. It starts with sk-or- and is made by openrouter.ai/keys.");
      }
      if (key === null) delete next.apiKey;
      else next.apiKey = key;
    }
    if (patch.model !== undefined) {
      const model = patch.model === null ? null : patch.model.trim();
      if (model !== null && !MODEL_SHAPE.test(model)) {
        throw new OpenRouterError("invalid_model", "That is not a model name. It looks like vendor/model-name, as on openrouter.ai/models.");
      }
      if (model !== null) {
        // A mistyped model would fail at the first question a reader asks; here it is caught while the admin is looking.
        const offered = await models().catch(() => null);
        if (offered && !offered.some((one) => one.id === model)) {
          throw new OpenRouterError("unknown_model", `OpenRouter does not list a model called ${model}. Pick one from the list.`);
        }
        next.model = model;
      } else delete next.model;
    }
    if (patch.dailyLimit !== undefined) {
      if (patch.dailyLimit === null) delete next.dailyLimit;
      else if (isLimit(patch.dailyLimit)) next.dailyLimit = patch.dailyLimit;
      else throw new OpenRouterError("invalid_limit", `The daily limit is a whole number of requests from 0 to ${MAX_DAILY_LIMIT}; 0 means no limit.`);
    }
    await mkdir(options.dataDir, { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(next)}\n`, 0o600);
    saved = next;
    return describe();
  }

  function failure(error: unknown, request: LlmRequest, timeout: AbortSignal): LlmError {
    if (error instanceof LlmError) return error;
    if (request.signal?.aborted) return new LlmError("aborted", "The request was cancelled.");
    if (timeout.aborted) return new LlmError("timeout", "The AI took too long to answer. Please try again.");
    return new LlmError("failed", "The API could not be reached. Check this computer's connection, then try again.");
  }

  async function httpFailure(response: Response, model: string): Promise<LlmError> {
    const detail = await messageOf(response);
    switch (response.status) {
      case 401:
      case 403:
        return new LlmError("not_logged_in", "The API key was refused. The admin can replace it on the admin page.");
      case 402:
        return new LlmError("failed", "The API account is out of credit. The admin can add credit at openrouter.ai, or choose a free model.");
      case 429:
        return new LlmError("failed", "The API is busy or its rate limit was reached. Please try again in a moment.");
      case 400:
      case 404:
        if (/model/i.test(detail)) {
          return new LlmError("failed", `The API does not know the model ${model}. The admin can choose another on the admin page.`);
        }
    }
    return new LlmError("failed", `The API could not answer (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
  }

  async function* answer(request: LlmRequest): AsyncGenerator<string, void, undefined> {
    if (request.signal?.aborted) throw new LlmError("aborted", "The request was cancelled.");
    const { apiKey, model } = resolved();
    if (!apiKey) throw new LlmError("cli_missing", "The API model has no API key yet. The admin sets one on the admin page.");
    if (!model) throw new LlmError("cli_missing", "The API model has no model chosen yet. The admin chooses one on the admin page.");

    const timeout = AbortSignal.timeout(TASK_PROFILES[request.task].timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "HTTP-Referer": "https://github.com/mrx-arafat/DeepRead",
        "X-Title": "DeepRead",
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: request.maxTokens ?? MAX_TOKENS[request.task],
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        // Measured on Nemotron 3 Super: a reasoning model took about 4 s to the first word of a short answer, and 0.6 s
        // with this, for the same answer at half the cost. Models that cannot switch it off ignore it.
        reasoning: { enabled: false },
      }),
      signal,
    };
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await doFetch(`${API}/chat/completions`, init);
      } catch (error) {
        throw failure(error, request, timeout);
      }
      const delay = retryDelays[attempt];
      // Only before a word of the answer has come: after that, trying again would say it twice.
      if (response.ok || !RETRY_STATUSES.has(response.status) || delay === undefined) break;
      await response.body?.cancel().catch(() => {});
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
      if (signal.aborted) throw failure(signal.reason, request, timeout);
    }
    if (!response.ok) throw await httpFailure(response, model);
    if (!response.body) throw new LlmError("failed", "The API answered with nothing. Please try again.");

    let wrote = false;
    try {
      for await (const data of dataLines(response.body)) {
        if (data === "[DONE]") break;
        let chunk: { error?: { message?: unknown }; choices?: Array<{ delta?: { content?: unknown } }> };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          const message = typeof chunk.error.message === "string" ? redact(chunk.error.message) : "unknown error";
          throw new LlmError("failed", `The API stopped the answer: ${message}`);
        }
        for (const choice of chunk.choices ?? []) {
          const content = choice.delta?.content;
          // `reasoning` deltas are the model thinking aloud, not the answer, so they are never shown.
          if (typeof content === "string" && content !== "") {
            wrote = true;
            yield content;
          }
        }
      }
    } catch (error) {
      throw failure(error, request, timeout);
    }
    if (!wrote) throw new LlmError("failed", "The AI helper ended without giving an answer. Please try again.");
  }

  async function* streamText(request: LlmRequest): AsyncGenerator<string, void, undefined> {
    const release = await gate.acquire(request.signal);
    try {
      yield* answer(request);
    } finally {
      release();
    }
  }

  function admit(reader: string): void {
    const { dailyLimit } = resolved();
    const counts = today();
    const used = counts.get(reader) ?? 0;
    if (dailyLimit > 0 && used >= dailyLimit) {
      throw new LlmError(
        "failed",
        `You have used today's ${dailyLimit} requests of the admin's API model. It starts again tomorrow, or ask the admin for more.`,
      );
    }
    counts.set(reader, used + 1);
    persist();
  }

  let kept: { key: string; at: number; value: { used: number; limit: number | null } | null } | null = null;

  /** What the key has spent and may spend, from OpenRouter; null when it cannot say. */
  async function askBalance(apiKey: string): Promise<{ used: number; limit: number | null } | null> {
    try {
      const response = await doFetch(`${API}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const data = ((await response.json()) as { data?: { usage?: unknown; limit?: unknown } }).data;
      if (typeof data?.usage !== "number") return null;
      return { used: data.usage, limit: typeof data.limit === "number" ? data.limit : null };
    } catch {
      return null;
    }
  }

  async function balance(): Promise<{ used: number; limit: number | null } | null> {
    const { apiKey } = resolved();
    if (!apiKey) return null;
    // The admin page asks whenever it opens or refreshes, and the answer hardly changes in a minute.
    if (kept && kept.key === apiKey && now() - kept.at < 60_000) return kept.value;
    const value = await askBalance(apiKey);
    kept = { key: apiKey, at: now(), value };
    return value;
  }

  async function test(): Promise<OpenRouterTest> {
    const { model } = resolved();
    const started = Date.now();
    const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);
    try {
      let text = "";
      for await (const piece of streamText({ task: "word", system: "Reply with the single word: ready", user: "Are you ready?", maxTokens: 24, signal: timeout })) text += piece;
      if (text.trim() === "") return { ok: false, message: "The model answered with nothing." };
      const ms = Date.now() - started;
      const key = resolved().apiKey;
      const left = key ? await askBalance(key) : null;
      return { ok: true, model: model ?? "", ms, ...(left && { balance: left }) };
    } catch (error) {
      return { ok: false, message: error instanceof LlmError ? error.message : "The test could not be run." };
    }
  }

  return {
    streamText,
    model: () => `openrouter:${resolved().model ?? "unset"}`,
    describe,
    available: async () => {
      const { apiKey, model } = resolved();
      return apiKey !== null && model !== null;
    },
    save,
    models,
    test,
    admit,
    balance,
  };
}
