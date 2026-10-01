// Drives the real process handling in llm.ts against a fake `claude` executable written to a temp dir,
// so spawning, stdin, abort, timeout and the concurrency limit are exercised without the real CLI or network.
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeText, createClaudeLlm } from "./llm.ts";
import type { LlmRequest } from "./llm.ts";

// First line of the prompt (stdin) picks the behaviour: "<mode> key=value ...". The rest is the real prompt.
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const input = readFileSync(0, "utf8");
const [directive] = input.split("\\n");
const [mode, ...pairs] = directive.split(" ");
const opts = Object.fromEntries(pairs.map((p) => p.split("=")));
const fixture = (name) => readFileSync(join(process.env.FAKE_FIXTURES, name), "utf8");
if (mode === "replay") {
  process.stdout.write(fixture("claude-haiku-stream.jsonl"));
} else if (mode === "signedout") {
  process.stdout.write(fixture("claude-error-not-logged-in.jsonl"));
  process.exit(1);
} else if (mode === "crash") {
  process.stderr.write("segfault-ish noise\\nthe real reason\\n");
  process.exit(3);
} else if (mode === "echo") {
  const args = process.argv.slice(2);
  const info = {
    model: args[args.indexOf("--model") + 1],
    system: args[args.indexOf("--system-prompt") + 1],
    tools: args[args.indexOf("--tools") + 1],
    settingSources: args[args.indexOf("--setting-sources") + 1],
    prompt: input.slice(directive.length + 1),
    hasClaudeCode: "CLAUDECODE" in process.env,
    hasEntrypoint: "CLAUDE_CODE_ENTRYPOINT" in process.env,
    maxThinking: process.env.MAX_THINKING_TOKENS,
    cwd: process.cwd(),
  };
  const text = JSON.stringify(info);
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));
} else if (mode === "hang") {
  writeFileSync(opts.pidfile, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "hold") {
  appendFileSync(opts.log, "+1\\n");
  setTimeout(() => {
    appendFileSync(opts.log, "-1\\n");
    process.stdout.write(fixture("claude-haiku-stream.jsonl"));
  }, Number(opts.ms));
}
`;

const CAPTURED_ANSWER =
  "**Ubiquitous** means something that is everywhere at the same time. It's something you find or see constantly all around you.\n\nFor example, smartphones are ubiquitous today because almost everyone has one.";

describe("createClaudeLlm", () => {
  let workDir: string;
  let fakeBin: string;
  const savedEnv = { ...process.env };

  const request = (user: string, extra: Partial<LlmRequest> = {}): LlmRequest => ({
    task: "explain",
    system: "You are a tutor.",
    user,
    ...extra,
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "deepread-llm-"));
    fakeBin = join(workDir, "fake-claude");
    writeFileSync(fakeBin, FAKE_CLAUDE);
    await chmod(fakeBin, 0o755);
    process.env.FAKE_FIXTURES = join(import.meta.dirname, "fixtures");
  });

  afterAll(async () => {
    process.env = savedEnv;
    await rm(workDir, { recursive: true, force: true });
  });

  it("should stream the answer text from a captured real run", async () => {
    const llm = createClaudeLlm({ bin: fakeBin });
    expect(await completeText(llm, request("replay\nExplain ubiquitous."))).toBe(CAPTURED_ANSWER);
  });

  it("should send the prompt on stdin with the right model, flags, directory and a clean environment", async () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    const llm = createClaudeLlm({ bin: fakeBin });
    const hugePrompt = "x".repeat(300_000);

    const word = JSON.parse(await completeText(llm, request(`echo\n${hugePrompt}`, { task: "word" })));
    expect(word).toMatchObject({
      // Measured: haiku named the wrong field's term for subject words ("induction" in a logic chapter).
      model: "sonnet",
      system: "You are a tutor.",
      tools: "",
      settingSources: "",
      hasClaudeCode: false,
      hasEntrypoint: false,
      maxThinking: "0",
    });
    expect(word.prompt).toBe(hugePrompt);
    // realpath: macOS reports its temp dir through the /private symlink.
    expect(word.cwd.replace(/^\/private/, "")).toBe(tmpdir().replace(/\/$/, ""));
  });

  it("should fail with a readable error when the CLI is missing, signed out, or crashes", async () => {
    const missing = createClaudeLlm({ bin: join(workDir, "does-not-exist") });
    await expect(completeText(missing, request("replay\n"))).rejects.toMatchObject({
      kind: "cli_missing",
      message: expect.stringContaining("not installed"),
    });

    const llm = createClaudeLlm({ bin: fakeBin });
    await expect(completeText(llm, request("signedout\n"))).rejects.toMatchObject({
      kind: "not_logged_in",
      message: expect.stringContaining("sign in"),
    });
    await expect(completeText(llm, request("crash\n"))).rejects.toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/exit code 3.*the real reason/s),
    });
  });

  it("should kill the model process when the caller aborts", async () => {
    const pidFile = join(workDir, "abort.pid");
    const controller = new AbortController();
    const pending = completeText(createClaudeLlm({ bin: fakeBin }), request(`hang pidfile=${pidFile}\n`, { signal: controller.signal }));
    const settled = pending.catch((error: unknown) => error);

    await vi.waitFor(() => expect(readFileSync(pidFile, "utf8")).not.toBe(""));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    controller.abort();

    expect(await settled).toMatchObject({ kind: "aborted" });
    expect(alive(pid)).toBe(false);
  });

  it("should kill the process and report a timeout when the model takes too long", async () => {
    const pidFile = join(workDir, "timeout.pid");
    const llm = createClaudeLlm({ bin: fakeBin, timeoutMs: 400 });
    await expect(completeText(llm, request(`hang pidfile=${pidFile}\n`))).rejects.toMatchObject({ kind: "timeout" });
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("should never run more than three model processes at once", async () => {
    const log = join(workDir, "concurrency.log");
    writeFileSync(log, "");
    const llm = createClaudeLlm({ bin: fakeBin });

    const answers = await Promise.all(
      Array.from({ length: 6 }, () => completeText(llm, request(`hold ms=300 log=${log}\n`))),
    );
    expect(answers).toEqual(Array(6).fill(CAPTURED_ANSWER));

    let running = 0;
    let peak = 0;
    for (const change of readFileSync(log, "utf8").trim().split("\n")) {
      running += Number(change);
      peak = Math.max(peak, running);
    }
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
