// Which AI tool answers, with what is installed and the model processes replaced by fakes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiProviderId } from "../shared/types.ts";
import { createAi, NO_AI_MESSAGE } from "./ai.ts";
import { completeText } from "./llm.ts";
import type { CliLlm } from "./llm.ts";

const fakeLlm = (id: AiProviderId): CliLlm => ({
  async *streamText() {
    yield `answer from ${id}`;
  },
  model: () => `${id}-model`,
  close() {},
});

const ask = { task: "word", system: "You are a tutor.", user: "ubiquitous" } as const;

describe("createAi", () => {
  let dataDir: string;
  const withInstalled = (...bins: string[]) =>
    createAi({ dataDir, installed: async (bin) => bins.includes(bin), create: fakeLlm });

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

  it("should say what to install when no helper is on this computer", async () => {
    const ai = withInstalled();
    expect((await ai.status()).active).toBeNull();
    await expect(completeText(ai, ask)).rejects.toMatchObject({ kind: "cli_missing", message: NO_AI_MESSAGE });
    await expect(ai.choose("claude")).rejects.toMatchObject({ kind: "cli_missing", message: expect.stringContaining("Claude Code is not installed") });
  });
});
