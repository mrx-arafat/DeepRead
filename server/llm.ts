// Model access through an AI command-line tool the reader already has (Claude Code or Codex), run headless with
// their own sign-in - no API key involved. Each tool runs without any tools of its own, so text in a book cannot
// make it touch the computer, and in an empty directory, so no project instructions are picked up.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseStreamLine } from "./claude-stream.ts";
import type { StreamEvent } from "./claude-stream.ts";
import { parseCodexLine } from "./codex-stream.ts";

export type LlmTask = "word" | "explain" | "preview" | "recap" | "quiz" | "ask";

/**
 * The one place that decides which Claude model answers what, how hard it thinks, and how long any tool gets.
 * Everything goes to Sonnet. Haiku is about twice as fast, but on passages it invented events and wrote
 * broken Bangla, and on words it gave the term of the wrong field ("induction" as the physics আবেশ instead of
 * the logic আরোহ, in every run) and unnatural examples. The reader trusts the Bangla line most.
 *
 * `effort` is Claude Code's effort level, which decides how long Sonnet thinks before it writes. Every task sets
 * its own: left unset, the CLI takes the reader's own Claude Code setting from the environment, and at xhigh
 * Sonnet thought for 4-8 s before the first word of a note and 3-10 s before the Bangla line of a word.
 * Measured on Chapter I of The Problems of Philosophy, as time to the first word:
 * - word: at high it answers an everyday word at once (about 1.2 s) and still thinks over a term of the book's
 *   subject, which the word prompt asks it to.
 * - explain, ask, preview, recap: at medium the first word came in 1.0-1.8 s every time (high 1.5-7.8 s, xhigh
 *   3.9-8.5 s), and the notes, their Bangla and their "Deeper meaning" were as correct as at xhigh.
 * - quiz: it arrives whole, in 9-11 s at medium or at high (19 s at xhigh), so it keeps high's extra thought
 *   for its answer key.
 */
export const TASK_PROFILES: Record<
  LlmTask,
  { model: "haiku" | "sonnet"; effort: "medium" | "high"; timeoutMs: number }
> = {
  word: { model: "sonnet", effort: "high", timeoutMs: 120_000 },
  explain: { model: "sonnet", effort: "medium", timeoutMs: 120_000 },
  ask: { model: "sonnet", effort: "medium", timeoutMs: 120_000 },
  preview: { model: "sonnet", effort: "medium", timeoutMs: 300_000 },
  recap: { model: "sonnet", effort: "medium", timeoutMs: 300_000 },
  quiz: { model: "sonnet", effort: "high", timeoutMs: 300_000 },
};

export type LlmRequest = {
  task: LlmTask;
  system: string;
  user: string;
  /** Aborting kills the model process. */
  signal?: AbortSignal;
};

export type Llm = {
  /** Yields answer text as it is generated. Throws LlmError on any failure. */
  streamText(request: LlmRequest): AsyncIterable<string>;
  /** Names what answers `task`, so a cached answer is only reused from the same model. */
  model(task: LlmTask): string;
};

export type LlmErrorKind = "cli_missing" | "not_logged_in" | "timeout" | "failed" | "aborted";

/** A model failure, with a message the reader can act on. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
  }
}

/** Collects a whole answer; for tasks that need the finished text (the quiz JSON). */
export async function completeText(llm: Llm, request: LlmRequest): Promise<string> {
  let text = "";
  for await (const piece of llm.streamText(request)) text += piece;
  return text;
}

export type CliLlmOptions = {
  /** Executable to run. Defaults to the tool's usual name on PATH. */
  bin?: string;
  maxConcurrent?: number;
  /** Replaces every task's time limit. */
  timeoutMs?: number;
};

export type CliLlm = Llm & {
  /** Kills any model process still running; call on shutdown. */
  close(): void;
};

/** How to run one AI command-line tool for a single answer, and read what it prints. */
type CliSpec = {
  /** The tool's name as the reader knows it. */
  name: string;
  bin: string;
  /** `scratch` is an empty directory of this request's own, removed when it ends; the tool runs in it. */
  args(request: LlmRequest, scratch: string): string[];
  /** Files to write into `scratch` before the tool starts. */
  files?(request: LlmRequest): Record<string, string>;
  env(request: LlmRequest): NodeJS.ProcessEnv;
  /** What goes in on stdin: prompts can be far too big for argv. */
  input(request: LlmRequest): string;
  parse(line: string): StreamEvent | null;
  model(task: LlmTask): string;
  /** What to tell a reader whose tool is installed but not signed in. */
  signIn: string;
};

const MAX_CONCURRENT = 3;
const STDERR_TAIL_CHARS = 600;
const KILL_GRACE_MS = 2_000;

// --tools "" and an empty --setting-sources are what keep the user's config out; see the header comment.
const CLAUDE_FLAGS = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
];

function claudeEnv(request: LlmRequest): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Set, not inherited: this variable overrides --effort and every settings file (see TASK_PROFILES).
  env.CLAUDE_CODE_EFFORT_LEVEL = TASK_PROFILES[request.task].effort;
  // Nested-session guard: with these set the CLI refuses to start inside another Claude Code session.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Measured with haiku: it otherwise reasons for thousands of tokens (25-45 s) before the first word of a short
  // answer. Either switch alone fixes it (~1.5 s to first text); sonnet ignores both and keeps a brief think.
  env.MAX_THINKING_TOKENS = "0";
  env.CLAUDE_CODE_DISABLE_THINKING = "1";
  // Skips startup telemetry and update checks: CLI init drops from ~750 ms to ~200 ms.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

function aborted(): LlmError {
  return new LlmError("aborted", "The request was cancelled.");
}

/** A counting semaphore; waiters are served in order and can leave the queue by aborting. */
function createGate(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return {
    async acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) throw aborted();
      if (active < limit) {
        active += 1;
      } else {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            const at = waiting.indexOf(turn);
            if (at >= 0) waiting.splice(at, 1);
            reject(aborted());
          };
          const turn = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          waiting.push(turn);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Hand the slot straight to the next waiter so the count never dips below the real load.
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      };
    },
  };
}

function failureFromResult(spec: CliSpec, result: Extract<StreamEvent, { kind: "result" }>): LlmError {
  if (result.apiStatus === 401 || /not logged in|\/login/i.test(result.text)) {
    return new LlmError("not_logged_in", spec.signIn);
  }
  return new LlmError("failed", `The AI could not answer: ${result.text || "unknown error"}`);
}

function failureFromSpawn(spec: CliSpec, error: unknown): LlmError {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return new LlmError(
      "cli_missing",
      `The AI helper (${spec.name}) is not installed on this computer. Install it, sign in, then try again.`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new LlmError("failed", `The AI helper could not start: ${detail}`);
}

function createCliLlm(spec: CliSpec, options: CliLlmOptions): CliLlm {
  const bin = options.bin ?? spec.bin;
  const gate = createGate(options.maxConcurrent ?? MAX_CONCURRENT);
  const running = new Set<ChildProcess>();

  async function* execute(request: LlmRequest): AsyncGenerator<string, void, undefined> {
    const profile = TASK_PROFILES[request.task];
    const scratch = await mkdtemp(join(tmpdir(), "deepread-"));
    try {
      for (const [name, content] of Object.entries(spec.files?.(request) ?? {})) {
        await writeFile(join(scratch, name), content);
      }
      yield* run(request, profile.timeoutMs, scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function* run(request: LlmRequest, timeoutMs: number, scratch: string): AsyncGenerator<string, void, undefined> {
    const child = spawn(bin, spec.args(request, scratch), { cwd: scratch, env: spec.env(request), stdio: ["pipe", "pipe", "pipe"] });
    running.add(child);

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    let hasExited = false;
    let killTimer: NodeJS.Timeout | undefined;
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        hasExited = true;
        clearTimeout(killTimer);
        running.delete(child);
        resolve(code);
      });
    });
    // Awaited below; this only stops an early return from leaving an unhandled rejection behind.
    exited.catch(() => {});

    // "failed": the tool reported a failure it would otherwise keep retrying, so it was stopped early.
    let stopReason: "timeout" | "aborted" | "failed" | null = null;
    const stop = (reason: "timeout" | "aborted" | "failed") => {
      if (stopReason || hasExited) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs ?? timeoutMs);
    const onAbort = () => stop("aborted");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    // EPIPE here only means the process already exited; its exit status explains why.
    child.stdin.on("error", () => {});
    child.stdin.end(spec.input(request));

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      let streamed = false;
      let result: Extract<StreamEvent, { kind: "result" }> | null = null;
      for await (const line of lines) {
        const event = spec.parse(line);
        if (event?.kind === "text") {
          streamed = true;
          yield event.text;
        } else if (event?.kind === "result") {
          result = event;
          if (event.isError) {
            stop("failed");
            break;
          }
        }
      }

      let code: number | null;
      try {
        code = await exited;
      } catch (error) {
        throw failureFromSpawn(spec, error);
      }
      if (stopReason === "timeout") {
        throw new LlmError("timeout", "The AI took too long to answer. Please try again.");
      }
      if (stopReason === "aborted") throw aborted();
      if (result?.isError) throw failureFromResult(spec, result);
      if (code !== 0) {
        const tail = stderrTail.trim();
        throw new LlmError(
          "failed",
          `The AI helper stopped unexpectedly (exit code ${code}).${tail ? ` Details: ${tail}` : ""}`,
        );
      }
      if (!result) {
        throw new LlmError("failed", "The AI helper ended without giving an answer. Please try again.");
      }
      // Partial messages are the normal path; this covers a CLI that only reports the final text.
      if (!streamed && result.text) yield result.text;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      lines.close();
      // The reader may stop iterating early; never leave the process running.
      stop("aborted");
      // Wait so the concurrency slot is only freed once the process is really gone.
      await exited.catch(() => {});
    }
  }

  async function* streamText(request: LlmRequest): AsyncGenerator<string, void, undefined> {
    const release = await gate.acquire(request.signal);
    try {
      yield* execute(request);
    } finally {
      release();
    }
  }

  return {
    streamText,
    model: spec.model,
    close() {
      for (const child of running) child.kill("SIGTERM");
    },
  };
}

/** Claude Code (`claude`), signed in with the reader's Claude account. */
export function createClaudeLlm(options: CliLlmOptions = {}): CliLlm {
  return createCliLlm(
    {
      name: "Claude Code",
      bin: "claude",
      args: (request) => ["-p", "--model", TASK_PROFILES[request.task].model, "--system-prompt", request.system, ...CLAUDE_FLAGS],
      env: claudeEnv,
      input: (request) => request.user,
      parse: parseStreamLine,
      model: (task) => TASK_PROFILES[task].model,
      signIn: "Claude Code is not signed in on this computer. Open a terminal, run `claude`, sign in, then try again.",
    },
    options,
  );
}

// Codex is a coding agent: every tool it has that could act on the computer is switched off, and the sandbox is
// read-only besides. Names a Codex version does not know are ignored, so older versions still start.
const CODEX_TOOLS_OFF = [
  "shell_tool",
  "unified_exec",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "memories",
  "plugins",
  "skill_search",
  "tool_suggest",
].flatMap((feature) => ["-c", `features.${feature}=false`]);

const CODEX_INSTRUCTIONS = "instructions.md";

/**
 * Codex (`codex`), signed in with the reader's ChatGPT account. DeepRead's instructions replace Codex's own coding
 * instructions. Codex still reads the reader's personal ~/.codex/AGENTS.md; it has no switch to leave that out.
 */
export function createCodexLlm(options: CliLlmOptions = {}): CliLlm {
  return createCliLlm(
    {
      name: "Codex",
      bin: "codex",
      files: (request) => ({ [CODEX_INSTRUCTIONS]: request.system }),
      args: (_request, scratch) => [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--cd",
        scratch,
        // JSON strings are valid TOML strings, which is what -c reads.
        "-c",
        `model_instructions_file=${JSON.stringify(join(scratch, CODEX_INSTRUCTIONS))}`,
        "-c",
        'model_reasoning_effort="low"',
        ...CODEX_TOOLS_OFF,
        "-",
      ],
      env: () => ({ ...process.env }),
      input: (request) => request.user,
      parse: parseCodexLine,
      model: () => "codex",
      signIn: "Codex is not signed in on this computer. Open a terminal, run `codex login`, sign in, then try again.",
    },
    options,
  );
}
