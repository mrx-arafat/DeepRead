// Model access through the locally installed Claude Code CLI in headless mode - no API key involved.
// The flags keep the user's own hooks, plugins, MCP servers and CLAUDE.md out of the answers.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { parseStreamLine } from "./claude-stream.ts";
import type { StreamEvent } from "./claude-stream.ts";

export type LlmTask = "word" | "explain" | "preview" | "recap" | "quiz" | "ask";

/**
 * The one place that decides which model answers what, and how long it gets.
 * Haiku answers single-word lookups in about a second and gets them right. On whole passages it invented
 * events and wrote broken Bangla, so everything longer goes to Sonnet (slower to start, but accurate).
 */
export const TASK_PROFILES: Record<LlmTask, { model: "haiku" | "sonnet"; timeoutMs: number }> = {
  word: { model: "haiku", timeoutMs: 60_000 },
  explain: { model: "sonnet", timeoutMs: 120_000 },
  ask: { model: "sonnet", timeoutMs: 120_000 },
  preview: { model: "sonnet", timeoutMs: 300_000 },
  recap: { model: "sonnet", timeoutMs: 300_000 },
  quiz: { model: "sonnet", timeoutMs: 300_000 },
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

export type ClaudeLlmOptions = {
  /** Executable to run. Defaults to `claude` on PATH. */
  bin?: string;
  maxConcurrent?: number;
  /** Replaces every task's time limit. */
  timeoutMs?: number;
};

export type ClaudeLlm = Llm & {
  /** Kills any model process still running; call on shutdown. */
  close(): void;
};

const MAX_CONCURRENT = 3;
const STDERR_TAIL_CHARS = 600;
const KILL_GRACE_MS = 2_000;

// --tools "" and an empty --setting-sources are what keep the user's config out; see the header comment.
const FIXED_FLAGS = [
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

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
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

function failureFromResult(result: Extract<StreamEvent, { kind: "result" }>): LlmError {
  if (result.apiStatus === 401 || /not logged in|\/login/i.test(result.text)) {
    return new LlmError(
      "not_logged_in",
      "Claude Code is not signed in on this computer. Open a terminal, run `claude`, sign in, then try again.",
    );
  }
  return new LlmError("failed", `The AI could not answer: ${result.text || "unknown error"}`);
}

function failureFromSpawn(error: unknown): LlmError {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return new LlmError(
      "cli_missing",
      "The AI helper (Claude Code) is not installed on this computer. Install it, sign in, then try again.",
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new LlmError("failed", `The AI helper could not start: ${detail}`);
}

export function createClaudeLlm(options: ClaudeLlmOptions = {}): ClaudeLlm {
  const bin = options.bin ?? "claude";
  const gate = createGate(options.maxConcurrent ?? MAX_CONCURRENT);
  const running = new Set<ChildProcess>();

  async function* execute(request: LlmRequest): AsyncGenerator<string, void, undefined> {
    const profile = TASK_PROFILES[request.task];
    const args = ["-p", "--model", profile.model, "--system-prompt", request.system, ...FIXED_FLAGS];
    // cwd is a neutral directory so no project CLAUDE.md or settings can be picked up.
    const child = spawn(bin, args, { cwd: tmpdir(), env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
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

    let stopReason: "timeout" | "aborted" | null = null;
    const stop = (reason: "timeout" | "aborted") => {
      if (stopReason || hasExited) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs ?? profile.timeoutMs);
    const onAbort = () => stop("aborted");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    // Chapter prompts are far too big for argv, so the prompt goes in on stdin.
    // EPIPE here only means the process already exited; its exit status explains why.
    child.stdin.on("error", () => {});
    child.stdin.end(request.user);

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      let streamed = false;
      let result: Extract<StreamEvent, { kind: "result" }> | null = null;
      for await (const line of lines) {
        const event = parseStreamLine(line);
        if (event?.kind === "text") {
          streamed = true;
          yield event.text;
        } else if (event?.kind === "result") {
          result = event;
        }
      }

      let code: number | null;
      try {
        code = await exited;
      } catch (error) {
        throw failureFromSpawn(error);
      }
      if (stopReason === "timeout") {
        throw new LlmError("timeout", "The AI took too long to answer. Please try again.");
      }
      if (stopReason === "aborted") throw aborted();
      if (result?.isError) throw failureFromResult(result);
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
    close() {
      for (const child of running) child.kill("SIGTERM");
    },
  };
}
