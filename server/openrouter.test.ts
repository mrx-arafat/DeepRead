// OpenRouter as an AI helper: the key and model the admin keeps, the streamed answers, and what goes wrong, with the
// network replaced by a fake fetch.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeText } from "./llm.ts";
import { createOpenRouter } from "./openrouter.ts";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const ask = { task: "word", system: "You are a tutor.", user: "ubiquitous" } as const;

/** What OpenRouter sends back for a streamed answer: a comment to keep the line open, deltas, a usage chunk, then [DONE]. */
function sse(...events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n"));
      for (const event of events) controller.enqueue(encoder.encode(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const delta = (content?: string, reasoning?: string) => ({ choices: [{ delta: { content, reasoning } }] });
const reply = (status: number, message: string) => new Response(JSON.stringify({ error: { message, code: status } }), { status });

type Call = { url: string; init: RequestInit };

describe("createOpenRouter", () => {
  let dataDir: string;
  let calls: Call[];
  let respond: (call: Call) => Response | Promise<Response>;

  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const make = (env: Record<string, string> = {}) => createOpenRouter({ dataDir, env, fetch: fetcher, retryDelaysMs: [0, 0] });
  const bodyOf = (call: Call) => JSON.parse(String(call.init.body)) as Record<string, unknown>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-openrouter-"));
    calls = [];
    respond = () => sse(delta("ok"), "[DONE]");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("should take the key and model from the environment, and let what the admin saves win, kept in a file only its owner reads", async () => {
    const env = { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL };
    expect(await make(env).describe()).toEqual({ keySet: true, keySource: "env", keyHint: "cdef", model: MODEL, modelSource: "env", dailyLimit: 100, usedToday: {} });

    const adminKey = "sk-or-v1-fedcba9876543210fedcba9876543210";
    const saved = await make(env).save({ apiKey: adminKey, model: "vendor/other-model" });
    expect(saved).toEqual({ keySet: true, keySource: "admin", keyHint: "3210", model: "vendor/other-model", modelSource: "admin", dailyLimit: 100, usedToday: {} });
    expect(JSON.stringify(saved)).not.toContain(adminKey);
    expect(JSON.stringify(saved)).not.toContain(KEY);

    // A new start reads what was saved; the file is the owner's alone, since it holds a key.
    expect(await make(env).describe()).toMatchObject({ keySource: "admin", model: "vendor/other-model" });
    expect((await stat(join(dataDir, "openrouter.json"))).mode & 0o777).toBe(0o600);

    // Clearing what was saved goes back to the environment's.
    expect(await make(env).save({ apiKey: null, model: null })).toEqual({ keySet: true, keySource: "env", keyHint: "cdef", model: MODEL, modelSource: "env", dailyLimit: 100, usedToday: {} });
    expect(await make().describe()).toEqual({ keySet: false, keySource: null, keyHint: null, model: null, modelSource: null, dailyLimit: 100, usedToday: {} });
  });

  it("should be able to answer only with both a key and a model", async () => {
    expect(await make({ OPENROUTER_API_KEY: KEY }).available()).toBe(false);
    expect(await make({ OPENROUTER_MODEL: MODEL }).available()).toBe(false);
    expect(await make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL }).available()).toBe(true);
  });

  it("should stream the answer from a chat completion that is asked not to think first, ignoring what the model reasons", async () => {
    respond = () => sse(delta(undefined, "hmm"), delta("Wide"), delta("spread", "more thought"), { choices: [], usage: { cost: 0.00001 } }, "[DONE]");
    const llm = make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL });

    expect(await completeText(llm, ask)).toBe("Widespread");
    const [call] = calls;
    expect(call?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call?.init.method).toBe("POST");
    expect((call?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(bodyOf(call!)).toMatchObject({
      model: MODEL,
      stream: true,
      messages: [
        { role: "system", content: "You are a tutor." },
        { role: "user", content: "ubiquitous" },
      ],
      // Measured: a first word in 0.6 s instead of 4 s, with the same answer.
      reasoning: { enabled: false },
    });
    expect(bodyOf(call!).max_tokens).toBeGreaterThan(0);
  });

  it("should name the model that answers, so a saved answer is only reused from the same one", async () => {
    const llm = make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL });
    expect(llm.model("word")).toBe(`openrouter:${MODEL}`);
    await llm.save({ model: "vendor/other-model" });
    expect(llm.model("explain")).toBe("openrouter:vendor/other-model");
  });

  it("should say what is wrong, in words the admin or the reader can act on, and never repeat the key", async () => {
    const llm = make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL });
    const failures: Array<[Response | Error, RegExp, string]> = [
      [reply(401, `No auth credentials found for ${KEY}`), /key was refused/i, "not_logged_in"],
      [reply(402, "Insufficient credits"), /credit/i, "failed"],
      [reply(400, `${MODEL} is not a valid model ID`), new RegExp(`does not know the model ${MODEL}`), "failed"],
      [reply(429, "Rate limit exceeded"), /busy|too many/i, "failed"],
      [reply(500, "upstream exploded"), /could not answer/i, "failed"],
      [new TypeError("fetch failed"), /could not be reached/i, "failed"],
    ];
    for (const [outcome, message, kind] of failures) {
      respond = () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      };
      const error = await completeText(llm, ask).catch((e: Error) => e);
      expect(error).toMatchObject({ name: "LlmError", kind });
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(KEY);
    }

    respond = () => sse(delta("Half"), { error: { message: "Provider disconnected" } });
    await expect(completeText(llm, ask)).rejects.toMatchObject({ kind: "failed", message: expect.stringContaining("Provider disconnected") });
  });

  it("should ask the admin for a key or a model rather than call OpenRouter without one", async () => {
    await expect(completeText(make({ OPENROUTER_MODEL: MODEL }), ask)).rejects.toMatchObject({ kind: "cli_missing", message: expect.stringContaining("API key") });
    await expect(completeText(make({ OPENROUTER_API_KEY: KEY }), ask)).rejects.toMatchObject({ kind: "cli_missing", message: expect.stringContaining("model") });
    expect(calls).toEqual([]);
  });

  it("should stop when the reader does", async () => {
    respond = (call) => {
      const signal = call.init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    };
    const controller = new AbortController();
    const answering = completeText(make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL }), { ...ask, signal: controller.signal });
    controller.abort();
    await expect(answering).rejects.toMatchObject({ kind: "aborted" });
  });

  it("should try again when a provider behind OpenRouter is briefly busy, before any of the answer has arrived, and no further", async () => {
    const llm = make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL });
    const busy = () => reply(429, "temporarily rate-limited upstream");

    // Busy twice, then another provider answers: the reader never sees it.
    const outcomes = [busy(), busy(), sse(delta("Done"), "[DONE]")];
    respond = () => outcomes.shift()!;
    expect(await completeText(llm, ask)).toBe("Done");
    expect(calls).toHaveLength(3);

    // Busy every time: three tries, then the reader is told.
    calls = [];
    respond = busy;
    await expect(completeText(llm, ask)).rejects.toMatchObject({ kind: "failed", message: expect.stringMatching(/busy/i) });
    expect(calls).toHaveLength(3);

    // A refused key, or an unknown model, will not change by asking again.
    for (const refusal of [reply(401, "no auth"), reply(400, "bad model ID"), reply(402, "credits")]) {
      calls = [];
      respond = () => refusal.clone();
      await completeText(llm, ask).catch(() => {});
      expect(calls).toHaveLength(1);
    }

    // Once words have come, an error is not retried: it would say the same thing twice.
    calls = [];
    respond = () => sse(delta("Half"), { error: { message: "Provider disconnected" } });
    await completeText(llm, ask).catch(() => {});
    expect(calls).toHaveLength(1);
  });

  describe("models", () => {
    const list = {
      data: [
        { id: "nvidia/nemotron-3-super-120b-a12b", name: "NVIDIA: Nemotron 3 Super", context_length: 262144, pricing: { prompt: "0.00000008", completion: "0.0000004" } },
        { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA: Nemotron 3 Super (free)", context_length: 262144, pricing: { prompt: "0", completion: "0" } },
        { id: "vendor/routed", name: "Vendor: Routed", context_length: 1000, pricing: { prompt: "-1", completion: "-1" } },
      ],
    };

    it("should list what OpenRouter offers with what it costs, asking once an hour at most", async () => {
      respond = () => new Response(JSON.stringify(list));
      const llm = make();
      expect(await llm.models()).toEqual([
        { id: "nvidia/nemotron-3-super-120b-a12b", name: "NVIDIA: Nemotron 3 Super", free: false, promptPerMillion: 0.08, completionPerMillion: 0.4 },
        { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA: Nemotron 3 Super (free)", free: true, promptPerMillion: 0, completionPerMillion: 0 },
        { id: "vendor/routed", name: "Vendor: Routed", free: false, promptPerMillion: null, completionPerMillion: null },
      ]);
      await llm.models();
      expect(calls.map((call) => call.url)).toEqual(["https://openrouter.ai/api/v1/models"]);
      // The list is public: nothing that identifies the admin goes with the request.
      expect((calls[0]?.init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    });

    it("should refuse a model OpenRouter does not list, so a mistyped one is caught when it is saved, not when a reader asks", async () => {
      respond = () => new Response(JSON.stringify(list));
      const llm = make({ OPENROUTER_API_KEY: KEY });
      await expect(llm.save({ model: "nvidia/nvfp4" })).rejects.toMatchObject({ code: "unknown_model", message: expect.stringContaining("nvidia/nvfp4") });
      expect(await llm.save({ model: "vendor/routed" })).toMatchObject({ model: "vendor/routed", modelSource: "admin" });
    });

    it("should save the model without checking it when the list cannot be had", async () => {
      respond = () => {
        throw new TypeError("fetch failed");
      };
      expect(await make().save({ model: "anything/goes" })).toMatchObject({ model: "anything/goes" });
    });
  });

  describe("test", () => {
    it("should answer whether the key and model work, with how long it took", async () => {
      respond = () => sse(delta("ready"), "[DONE]");
      const result = await make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL }).test();
      expect(result).toMatchObject({ ok: true, model: MODEL });
      expect(bodyOf(calls[0]!).max_tokens).toBeLessThanOrEqual(32);

      respond = () => reply(401, "bad key");
      expect(await make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL }).test()).toEqual({ ok: false, message: expect.stringContaining("key was refused") });
    });
  });

  it("should keep nothing in the file when there is nothing saved", async () => {
    const llm = make({ OPENROUTER_API_KEY: KEY });
    await llm.save({ model: "vendor/x" });
    await llm.save({ model: null });
    expect(JSON.parse(await readFile(join(dataDir, "openrouter.json"), "utf8"))).toEqual({});
  });
  it("should keep each reader to a number of requests a day, which the admin sets, and begin again the next day", async () => {
    let now = Date.UTC(2026, 9, 7, 12);
    const llm = createOpenRouter({ dataDir, env: { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL, OPENROUTER_DAILY_LIMIT: "2" }, fetch: fetcher, now: () => now });
    llm.admit("mina");
    llm.admit("mina");
    expect(() => llm.admit("mina")).toThrowError(expect.objectContaining({ kind: "failed", message: expect.stringContaining("2 requests") }));
    llm.admit("sam");
    expect((await llm.describe()).usedToday).toEqual({ mina: 2, sam: 1 });

    now += 24 * 60 * 60 * 1000;
    expect(() => llm.admit("mina")).not.toThrow();
    expect((await llm.describe()).usedToday).toEqual({ mina: 1 });

    // What the admin saves wins over .env, and 0 means no limit at all.
    expect((await llm.save({ dailyLimit: 0 })).dailyLimit).toBe(0);
    for (let i = 0; i < 50; i++) llm.admit("mina");
    await expect(llm.save({ dailyLimit: -3 })).rejects.toMatchObject({ code: "invalid_limit" });
    await expect(llm.save({ dailyLimit: 1.5 })).rejects.toMatchObject({ code: "invalid_limit" });
    expect((await llm.save({ dailyLimit: null })).dailyLimit).toBe(2);
  });

  it("should tell the admin how much of the key's credit is left, when the test is run", async () => {
    respond = (call) =>
      call.url.endsWith("/key") ? new Response(JSON.stringify({ data: { usage: 0.4, limit: 2 } })) : sse(delta("ready"), "[DONE]");
    const result = await make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL }).test();
    expect(result).toMatchObject({ ok: true, balance: { used: 0.4, limit: 2 } });
    expect((calls.find((call) => call.url.endsWith("/key"))?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);

    // A key with no limit set has none to show; a failed look at it does not fail the test.
    respond = (call) => (call.url.endsWith("/key") ? reply(500, "down") : sse(delta("ready"), "[DONE]"));
    expect(await make({ OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL }).test()).toEqual({ ok: true, model: MODEL, ms: expect.any(Number) });
  });
  it("should say how much of the key's credit is gone for the admin page, asking OpenRouter once a minute at most", async () => {
    let now = 5_000_000;
    respond = () => new Response(JSON.stringify({ data: { usage: 0.25, limit: 2 } }));
    const llm = createOpenRouter({ dataDir, env: { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL }, fetch: fetcher, now: () => now });
    expect(await llm.balance()).toEqual({ used: 0.25, limit: 2 });
    await llm.balance();
    expect(calls.filter((call) => call.url.endsWith("/key"))).toHaveLength(1);
    now += 61_000;
    await llm.balance();
    expect(calls.filter((call) => call.url.endsWith("/key"))).toHaveLength(2);

    // Without a key there is nothing to ask, and a refusal or an outage is no balance rather than an error.
    expect(await make().balance()).toBeNull();
    respond = () => reply(500, "down");
    now += 61_000;
    expect(await llm.balance()).toBeNull();
  });
});
