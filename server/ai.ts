// Which AI helper answers: the one chosen under Aa, else the first that can (AI_PROVIDERS order). The command-line tools
// come first because they need nothing from the admin; OpenRouter is last, so it is the fallback for readers whose computer
// has none, and the admin can make it the helper outright.
// Reading, listening and the quick word translation all work without any; only explanations need one.
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AI_PROVIDERS, isAiProviderId, type AiProviderId, type AiStatus } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { createClaudeLlm, createCodexLlm, helperEnv, LlmError } from "./llm.ts";
import type { CliLlm, Llm, LlmRequest } from "./llm.ts";
import type { OpenRouter } from "./openrouter.ts";

type CliId = Exclude<AiProviderId, "openrouter">;

const BINS: Record<CliId, string> = { claude: "claude", codex: "codex" };
/** How long a look at what is installed holds. Starting a program per question would let one reader keep the server busy. */
const LOOK_HOLDS_MS = 30_000;
const IDS = Object.keys(AI_PROVIDERS) as AiProviderId[];

export const NO_AI_MESSAGE =
  "DeepRead needs an AI helper to explain the book: Claude Code or Codex on this computer, or an OpenRouter key from the admin. Install one and sign in, then pick it under Aa.";

/** What one reader may use. With profiles that is what the admin gave them; the admin's own profile and a library without profiles use anything that works. */
export type AiAccess = {
  allowed: readonly AiProviderId[] | "all";
  /** The reader's own pick among the helpers they may use. */
  choice?: AiProviderId | null;
  /** The helpers the reader has asked the admin for. */
  requested?: readonly AiProviderId[];
  /** Who is reading, so the API model can count their requests against their day. */
  reader?: string;
};

export type Ai = Llm & {
  /** Looks again at what is installed. */
  status(): Promise<AiStatus>;
  /** Looks, unless a look in the last half minute still holds: before a request works out which helper answers it. */
  ensureStatus(): Promise<void>;
  /** The helpers as one reader sees them: each with whether it can answer, whether it is theirs, and whether they asked for it. */
  statusFor(access: AiAccess): Promise<AiStatus>;
  /** A helper that answers for one reader, with only what they may use. Call ensureStatus first, so it knows what can answer. */
  for(access: AiAccess): Llm;
  /** Answers with `id` from now on, and remembers it. Throws LlmError if it is not installed. */
  choose(id: AiProviderId): Promise<AiStatus>;
  close(): void;
};

export type AiOptions = {
  /** Where the reader's choice is kept (settings.json). */
  dataDir: string;
  /** Whether a tool's command is on this computer. */
  installed?: (bin: string) => Promise<boolean>;
  create?: (id: CliId) => CliLlm;
  /** The clock, for tests of how long a look holds. */
  now?: () => number;
  /** The admin's OpenRouter key and model, which answer for everyone while they are set. */
  openrouter?: OpenRouter;
};

function onPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 10_000, env: helperEnv() }, (error) => resolve(!error));
  });
}

const CREATE: Record<CliId, (dataDir: string) => CliLlm> = {
  claude: () => createClaudeLlm(),
  codex: (dataDir) => createCodexLlm({ home: join(dataDir, "codex-home") }),
};

export { isAiProviderId };

export function createAi(options: AiOptions): Ai {
  const installed = options.installed ?? onPath;
  const create = options.create ?? ((id: CliId) => CREATE[id](options.dataDir));
  const settingsFile = join(options.dataDir, "settings.json");
  const llms = new Map<CliId, CliLlm>();
  let active: AiProviderId | null = null;
  // What could answer when status() last looked: `for` names the model of a request by it, without waiting for a look.
  const available = new Map<AiProviderId, boolean>();
  const now = options.now ?? Date.now;
  let lookedAt = Number.NEGATIVE_INFINITY;
  let looking: Promise<AiStatus> | null = null;
  let lastProviders: AiStatus["providers"] = [];

  const llmFor = (id: AiProviderId): Llm => {
    if (id === "openrouter") {
      if (!options.openrouter) throw new LlmError("cli_missing", NO_AI_MESSAGE);
      return options.openrouter;
    }
    let llm = llms.get(id);
    if (!llm) {
      llm = create(id);
      llms.set(id, llm);
    }
    return llm;
  };

  const openrouterReady = async (): Promise<boolean> => (await options.openrouter?.available()) ?? false;

  async function readSettings(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Looks now, and shares the look with whoever asks while it is under way. */
  function status(): Promise<AiStatus> {
    looking ??= look().finally(() => {
      looking = null;
    });
    return looking;
  }

  async function look(): Promise<AiStatus> {
    const [found, ready, view] = await Promise.all([
      Promise.all(IDS.map((id) => (id === "openrouter" ? Promise.resolve(false) : installed(BINS[id])))),
      openrouterReady(),
      options.openrouter?.describe(),
    ]);
    const providers = IDS.map((id, at) => {
      if (id !== "openrouter") return { id, name: AI_PROVIDERS[id], installed: found[at] ?? false };
      const detail = ready ? view?.model : view?.keySet ? "needs a model" : "needs an API key";
      return { id, name: AI_PROVIDERS[id], installed: ready, ...(detail && { detail }) };
    });
    for (const provider of providers) available.set(provider.id, provider.installed);
    lastProviders = providers;
    lookedAt = now();
    const saved = (await readSettings()).ai;
    const usable = providers.filter((provider) => provider.installed);
    active = usable.find((provider) => provider.id === saved)?.id ?? usable[0]?.id ?? null;
    return { active, providers };
  }

  async function choose(id: AiProviderId): Promise<AiStatus> {
    if (id === "openrouter") {
      if (!(await openrouterReady())) {
        throw new LlmError("cli_missing", "The API model needs an API key and a model first. The admin sets them on the admin page.");
      }
    } else if (!(await installed(BINS[id]))) {
      throw new LlmError("cli_missing", `${AI_PROVIDERS[id]} is not installed on this computer. Install it and sign in first.`);
    }
    await mkdir(options.dataDir, { recursive: true });
    await writeFileAtomic(settingsFile, `${JSON.stringify({ ...(await readSettings()), ai: id }, null, 2)}\n`);
    return status();
  }

  /** The helper that answers a reader: their pick if it is theirs and can answer, else the first of theirs that can. */
  function pickFor(access: AiAccess): AiProviderId | null {
    const usable = IDS.filter((id) => available.get(id) === true && (access.allowed === "all" || access.allowed.includes(id)));
    return access.choice && usable.includes(access.choice) ? access.choice : (usable[0] ?? null);
  }

  function noHelperFor(access: AiAccess): LlmError {
    if (access.allowed === "all") return new LlmError("cli_missing", NO_AI_MESSAGE);
    if (access.allowed.length === 0) {
      return new LlmError("cli_missing", "You do not have an AI helper yet. Open Aa and ask the admin for one: it is the admin who decides who may use which.");
    }
    return new LlmError("cli_missing", "The AI helper the admin gave you is not available right now. Ask the admin.");
  }

  async function ensureStatus(): Promise<void> {
    if (now() - lookedAt >= LOOK_HOLDS_MS) await status();
  }

  async function statusFor(access: AiAccess): Promise<AiStatus> {
    await ensureStatus();
    const providers = lastProviders;
    return {
      active: pickFor(access),
      providers: providers.map((provider) => ({
        ...provider,
        allowed: access.allowed === "all" || access.allowed.includes(provider.id),
        requested: access.requested?.includes(provider.id) ?? false,
      })),
    };
  }

  function forReader(access: AiAccess): Llm {
    return {
      async *streamText(request) {
        // A reader the admin gave nothing is told so at once: no look at the computer is worth making for them.
        if (access.allowed !== "all" && access.allowed.length === 0) throw noHelperFor(access);
        let id = pickFor(access);
        if (!id) {
          // One may have been installed, or the admin may have set the key, since the last look.
          await ensureStatus();
          id = pickFor(access);
        }
        if (!id) throw noHelperFor(access);
        // The API model costs the admin money per request, so a reader's are counted; the admin's own are not.
        if (id === "openrouter" && access.allowed !== "all" && access.reader) options.openrouter?.admit(access.reader);
        yield* llmFor(id).streamText(request);
      },
      model(task) {
        const id = pickFor(access);
        return id ? llmFor(id).model(task) : "none";
      },
    };
  }

  async function* streamText(request: LlmRequest): AsyncGenerator<string, void, undefined> {
    // One may have been installed since DeepRead started, or OpenRouter given a key; and OpenRouter may have lost its key.
    if (!active || (active === "openrouter" && !(await openrouterReady()))) await status();
    if (!active) throw new LlmError("cli_missing", NO_AI_MESSAGE);
    yield* llmFor(active).streamText(request);
  }

  return {
    streamText,
    model: (task) => (active ? llmFor(active).model(task) : "none"),
    status,
    ensureStatus,
    statusFor,
    for: forReader,
    choose,
    close() {
      for (const llm of llms.values()) llm.close();
    },
  };
}
