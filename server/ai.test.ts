// Which AI tool answers, with what is installed and the model processes replaced by fakes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiProviderId } from "../shared/types.ts";
import { createAi, NO_AI_MESSAGE } from "./ai.ts";
import { completeText, LlmError } from "./llm.ts";
import type { CliLlm } from "./llm.ts";
import type { OpenRouter } from "./openrouter.ts";

const fakeLlm = (id: AiProviderId): CliLlm => ({
  async *streamText() {
    yield `answer from ${id}`;
  },
  model: () => `${id}-model`,
  close() {},
});

const ask = { task: "word", system: "You are a tutor.", user: "ubiquitous" } as const;

/** The helper for one reader, once the server has looked at what it has: how a request finds it. */
async function asFor(ai: ReturnType<typeof createAi>, access: Parameters<ReturnType<typeof createAi>["for"]>[0]) {
  await ai.ensureStatus();
  return ai.for(access);
}

/** OpenRouter with a key and model, or without, answering from nowhere. */
function fakeOpenRouter(ready: boolean): OpenRouter {
  return {
    async *streamText() {
      yield "answer from openrouter";
    },
    model: () => "openrouter:vendor/model",
    describe: async () => ({
      keySet: true,
      keySource: "env",
      keyHint: "abcd",
      model: ready ? "vendor/model" : null,
      modelSource: ready ? "env" : null,
      dailyLimit: 100,
      usedToday: {},
      baseUrl: "https://openrouter.ai/api/v1",
      baseUrlSource: null,
    }),
    admit() {},
    balance: async () => null,
    available: async () => ready,
    save: async () => {
      throw new Error("not used");
    },
    models: async () => [],
    test: async () => ({ ok: true, model: "vendor/model", ms: 1 }),
  };
}

describe("createAi", () => {
  let dataDir: string;
  const withInstalled = (...bins: string[]) =>
    createAi({ dataDir, installed: async (bin) => bins.includes(bin), create: fakeLlm });
  const withOpenRouter = (ready: boolean, ...bins: string[]) =>
    createAi({ dataDir, installed: async (bin) => bins.includes(bin), create: fakeLlm, openrouter: fakeOpenRouter(ready) });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-ai-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("should answer with the first helper that is installed", async () => {
    const ai = withInstalled("codex");
    expect(await ai.status()).toEqual({
      active: "codex",
      providers: [
        { id: "claude", name: "Claude Code", installed: false },
        { id: "codex", name: "Codex", installed: true },
        { id: "openrouter", name: "API Model", installed: false, detail: "needs an API key" },
      ],
    });
    expect(await completeText(ai, ask)).toBe("answer from codex");
    expect(ai.model("word")).toBe("codex-model");
  });

  it("should remember the reader's choice, and fall back when that helper is gone", async () => {
    await withInstalled("claude", "codex").choose("codex");
    expect((await withInstalled("claude", "codex").status()).active).toBe("codex");
    expect((await withInstalled("claude").status()).active).toBe("claude");
  });

  it("should answer through OpenRouter for every reader when no command-line helper is on this computer, which is the admin's gift to them", async () => {
    const ai = withOpenRouter(true);
    expect(await ai.status()).toMatchObject({
      active: "openrouter",
      providers: expect.arrayContaining([{ id: "openrouter", name: "API Model", installed: true, detail: "vendor/model" }]),
    });
    expect(await completeText(ai, ask)).toBe("answer from openrouter");
    expect(ai.model("word")).toBe("openrouter:vendor/model");
  });

  it("should prefer an installed helper to OpenRouter until the admin chooses OpenRouter, and then keep to it", async () => {
    expect((await withOpenRouter(true, "claude").status()).active).toBe("claude");

    const ai = withOpenRouter(true, "claude");
    expect((await ai.choose("openrouter")).active).toBe("openrouter");
    expect((await withOpenRouter(true, "claude").status()).active).toBe("openrouter");
    // The choice only holds while OpenRouter can answer: with no key left, the installed helper takes over again.
    expect((await withOpenRouter(false, "claude").status()).active).toBe("claude");
  });

  it("should refuse OpenRouter as the helper until it has a key and a model, and say who sets them", async () => {
    const error = await withOpenRouter(false).choose("openrouter").catch((e: Error) => e);
    expect(error).toMatchObject({ kind: "cli_missing", message: expect.stringContaining("admin") });
    const ai = withOpenRouter(false);
    await expect(completeText(ai, ask)).rejects.toMatchObject({ kind: "cli_missing", message: NO_AI_MESSAGE });
  });

  it("should say what to install when no helper is on this computer", async () => {
    const ai = withInstalled();
    expect((await ai.status()).active).toBeNull();
    await expect(completeText(ai, ask)).rejects.toMatchObject({ kind: "cli_missing", message: NO_AI_MESSAGE });
    await expect(ai.choose("claude")).rejects.toMatchObject({ kind: "cli_missing", message: expect.stringContaining("Claude Code is not installed") });
  });
  describe("for one reader", () => {
    const server = (ready = true) => withOpenRouter(ready, "claude");

    it("should offer a reader only what the admin gave them, and show the rest as not theirs yet, asked for or not", async () => {
      const ai = server();
      expect(await ai.statusFor({ allowed: [] })).toEqual({
        active: null,
        providers: [
          { id: "claude", name: "Claude Code", installed: true, allowed: false, requested: false },
          { id: "codex", name: "Codex", installed: false, allowed: false, requested: false },
          { id: "openrouter", name: "API Model", installed: true, detail: "vendor/model", allowed: false, requested: false },
        ],
      });
      const asked = await ai.statusFor({ allowed: [], requested: ["claude"] });
      expect(asked.providers.map((p) => [p.id, p.requested])).toEqual([["claude", true], ["codex", false], ["openrouter", false]]);

      const given = await ai.statusFor({ allowed: ["openrouter"] });
      expect(given.active).toBe("openrouter");
      expect(given.providers.map((p) => [p.id, p.allowed])).toEqual([["claude", false], ["codex", false], ["openrouter", true]]);
    });

    it("should answer a reader only with a helper they were given, and with their own pick among those", async () => {
      const ai = server();
      expect(await completeText(await asFor(ai, { allowed: ["openrouter"] }), ask)).toBe("answer from openrouter");
      expect(await completeText(await asFor(ai, { allowed: ["claude", "openrouter"] }), ask)).toBe("answer from claude");
      expect(await completeText(await asFor(ai, { allowed: ["claude", "openrouter"], choice: "openrouter" }), ask)).toBe("answer from openrouter");
      // A pick the admin has since taken back, or that cannot answer, is ignored.
      expect(await completeText(await asFor(ai, { allowed: ["claude"], choice: "openrouter" }), ask)).toBe("answer from claude");
      // The admin's own profile may use anything that works.
      expect((await ai.statusFor({ allowed: "all" })).active).toBe("claude");
    });

    it("should tell a reader with no helper to ask the admin, and a reader whose helper is gone that it is not there right now", async () => {
      const ai = server();
      const none = await asFor(ai, { allowed: [] });
      await expect(completeText(none, ask)).rejects.toMatchObject({ kind: "cli_missing", message: expect.stringContaining("ask the admin for one") });
      expect(none.model("word")).toBe("none");

      const gone = await asFor(withOpenRouter(false), { allowed: ["codex", "openrouter"] });
      await expect(completeText(gone, ask)).rejects.toMatchObject({ kind: "cli_missing", message: expect.stringContaining("not available right now") });
    });
  });
  it("should count a reader's requests of the API model against their day, but not the admin's, and not those a command-line helper answers", async () => {
    const admitted: string[] = [];
    const openrouter = { ...fakeOpenRouter(true), admit: (reader: string) => void admitted.push(reader) };
    const ai = createAi({ dataDir, installed: async (bin) => bin === "claude", create: fakeLlm, openrouter });
    await ai.ensureStatus();

    await completeText(ai.for({ allowed: ["openrouter"], reader: "mina" }), ask);
    await completeText(ai.for({ allowed: "all", reader: "arafat", choice: "openrouter" }), ask);
    await completeText(ai.for({ allowed: ["claude", "openrouter"], reader: "mina" }), ask);
    await completeText(ai.for({ allowed: ["openrouter"], reader: "mina" }), ask);
    expect(admitted).toEqual(["mina", "mina"]);

    // Over the limit: the request is refused with the reason, and nothing is asked of the model.
    const over = { ...openrouter, admit: () => { throw new LlmError("failed", "You have used today's 100 requests"); } };
    const limited = createAi({ dataDir, installed: async () => false, create: fakeLlm, openrouter: over });
    await limited.ensureStatus();
    await expect(completeText(limited.for({ allowed: ["openrouter"], reader: "mina" }), ask)).rejects.toMatchObject({ kind: "failed" });
  });

  describe("looking at what is installed", () => {
    it("should not start a program for a reader who was given no helper, however often they ask", async () => {
      let looks = 0;
      const ai = createAi({ dataDir, installed: async () => (looks++, true), create: fakeLlm });
      await ai.ensureStatus();
      const looked = looks;
      for (let i = 0; i < 5; i++) {
        await expect(completeText(ai.for({ allowed: [] }), ask)).rejects.toMatchObject({ kind: "cli_missing" });
      }
      expect(looks).toBe(looked);
    });

    it("should look again only once the last look is old, and as one look however many ask at the same time", async () => {
      let looks = 0;
      let now = 1_000_000;
      const ai = createAi({ dataDir, installed: async () => (looks++, true), create: fakeLlm, now: () => now });
      await Promise.all([ai.ensureStatus(), ai.ensureStatus(), ai.ensureStatus()]);
      expect(looks).toBe(2);
      now += 10_000;
      await ai.ensureStatus();
      expect(looks).toBe(2);
      now += 60_000;
      await ai.ensureStatus();
      expect(looks).toBe(4);
    });
  });
});
