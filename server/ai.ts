// Which AI tool answers: the one the reader chose under Aa, else the first one installed (AI_PROVIDERS order).
// Reading, listening and the quick word translation all work without any; only explanations need one.
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AI_PROVIDERS, type AiProviderId, type AiStatus } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { createClaudeLlm, createCodexLlm, LlmError } from "./llm.ts";
import type { CliLlm, Llm, LlmRequest } from "./llm.ts";

const BINS: Record<AiProviderId, string> = { claude: "claude", codex: "codex" };
const IDS = Object.keys(AI_PROVIDERS) as AiProviderId[];

export const NO_AI_MESSAGE =
  "DeepRead needs an AI helper to explain the book: Claude Code or Codex. Install one and sign in, then pick it under Aa.";

export type Ai = Llm & {
  /** Looks again at what is installed. */
  status(): Promise<AiStatus>;
  /** Answers with `id` from now on, and remembers it. Throws LlmError if it is not installed. */
  choose(id: AiProviderId): Promise<AiStatus>;
  close(): void;
};

export type AiOptions = {
  /** Where the reader's choice is kept (settings.json). */
  dataDir: string;
  /** Whether a tool's command is on this computer. */
  installed?: (bin: string) => Promise<boolean>;
  create?: (id: AiProviderId) => CliLlm;
};

function onPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 10_000 }, (error) => resolve(!error));
  });
}

const CREATE: Record<AiProviderId, () => CliLlm> = { claude: createClaudeLlm, codex: createCodexLlm };

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && value in AI_PROVIDERS;
}

export function createAi(options: AiOptions): Ai {
  const installed = options.installed ?? onPath;
  const create = options.create ?? ((id: AiProviderId) => CREATE[id]());
  const settingsFile = join(options.dataDir, "settings.json");
  const llms = new Map<AiProviderId, CliLlm>();
  let active: AiProviderId | null = null;

  const llmFor = (id: AiProviderId): CliLlm => {
    let llm = llms.get(id);
    if (!llm) {
      llm = create(id);
      llms.set(id, llm);
    }
    return llm;
  };

  async function readSettings(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async function status(): Promise<AiStatus> {
    const found = await Promise.all(IDS.map((id) => installed(BINS[id])));
    const providers = IDS.map((id, at) => ({ id, name: AI_PROVIDERS[id], installed: found[at] ?? false }));
    const saved = (await readSettings()).ai;
    const usable = providers.filter((provider) => provider.installed);
    active = usable.find((provider) => provider.id === saved)?.id ?? usable[0]?.id ?? null;
    return { active, providers };
  }

  async function choose(id: AiProviderId): Promise<AiStatus> {
    if (!(await installed(BINS[id]))) {
      throw new LlmError("cli_missing", `${AI_PROVIDERS[id]} is not installed on this computer. Install it and sign in first.`);
    }
    await mkdir(options.dataDir, { recursive: true });
    await writeFileAtomic(settingsFile, `${JSON.stringify({ ...(await readSettings()), ai: id }, null, 2)}\n`);
    return status();
  }

  async function* streamText(request: LlmRequest): AsyncGenerator<string, void, undefined> {
    // One may have been installed since DeepRead started.
    if (!active) await status();
    if (!active) throw new LlmError("cli_missing", NO_AI_MESSAGE);
    yield* llmFor(active).streamText(request);
  }

  return {
    streamText,
    model: (task) => (active ? llmFor(active).model(task) : "none"),
    status,
    choose,
    close() {
      for (const llm of llms.values()) llm.close();
    },
  };
}
