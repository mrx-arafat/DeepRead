// Drives the real process handling in llm.ts against a fake `claude` / `codex` executable written to a temp dir,
// so spawning, stdin, abort, timeout and the concurrency limit are exercised without the real CLIs or network.
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeText, createClaudeLlm, createCodexLlm } from "./llm.ts";
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
// "echo present=A,B": which of those variables this process was started with.
const present = (opts.present ?? "").split(",").filter((name) => name !== "" && name in process.env);
if (process.argv[2] === "exec") {
  // Codex.
  const args = process.argv.slice(3);
  if (mode === "replay") {
    process.stdout.write(fixture("codex-stream.jsonl"));
  } else if (mode === "signedout") {
    // The real Codex reports the refused sign-in, then keeps retrying for about twenty seconds.
    writeFileSync(opts.pidfile, String(process.pid));
    process.stdout.write(fixture("codex-error-not-logged-in.jsonl").split("\\n").slice(0, 3).join("\\n") + "\\n");
    setInterval(() => {}, 1000);
  } else if (mode === "echo") {
    const setting = (key) => args.find((arg) => arg.startsWith(key + "="))?.slice(key.length + 1);
    const info = {
      sandbox: args[args.indexOf("--sandbox") + 1],
      ignoresUserConfig: args.includes("--ignore-user-config"),
      instructions: readFileSync(JSON.parse(setting("model_instructions_file")), "utf8"),
      toolsOff: args.filter((arg) => /^features\\..*=false$/.test(arg)).map((arg) => arg.slice(9, -6)),
      lastArg: args.at(-1),
      prompt: input.slice(directive.length + 1),
      cwd: process.cwd(),
      codexHome: process.env.CODEX_HOME,
      present,
    };
    console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify(info) } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
  }
} else if (mode === "replay") {
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
    effort: process.env.CLAUDE_CODE_EFFORT_LEVEL,
    cwd: process.cwd(),
    present,
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

/** The tool ran in an empty directory of its own under the temp dir, removed once the answer was in. */
function expectPrivateDirectoryGone(cwd: string) {
  // realpath: macOS reports its temp dir through the /private symlink.
  expect(cwd.replace(/^\/private/, "").startsWith(join(tmpdir(), "deepread-").replace(/^\/private/, ""))).toBe(true);
  expect(existsSync(cwd)).toBe(false);
}

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
    // The reader's own Claude Code setting, which DeepRead inherits when started from inside Claude Code.
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "xhigh";
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
      // Measured: at xhigh Sonnet thought before every word, 3-10 s before the Bangla line.
      effort: "high",
    });
    expect(word.prompt).toBe(hugePrompt);
    expectPrivateDirectoryGone(word.cwd);
  });

  it("should keep DeepRead's own secrets out of the environment of both AI helpers", async () => {
    const secrets = [
      "DEEPREAD_ENCRYPTION_KEY",
      "DEEPREAD_R2_ACCESS_KEY_ID",
      "DEEPREAD_R2_SECRET_ACCESS_KEY",
      "OPENROUTER_API_KEY",
      "ADMIN_PASSKEY",
      "DEEPREAD_REMOTE_KEY",
    ];
    try {
      for (const name of secrets) vi.stubEnv(name, "fake-secret");
      const ask = request(`echo present=${secrets.join(",")},FAKE_FIXTURES\n`);
      const claude = JSON.parse(await completeText(createClaudeLlm({ bin: fakeBin }), ask));
      const codex = JSON.parse(await completeText(createCodexLlm({ bin: fakeBin, home: join(workDir, "codex-home") }), ask));
      // FAKE_FIXTURES shows the rest of the environment still gets through.
      expect(claude.present).toEqual(["FAKE_FIXTURES"]);
      expect(codex.present).toEqual(["FAKE_FIXTURES"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should run every other task at its own effort level too, whatever the reader's Claude Code setting is", async () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "xhigh";
    const llm = createClaudeLlm({ bin: fakeBin });
    const tasks = ["explain", "ask", "preview", "recap", "quiz"] as const;
    const efforts = await Promise.all(
      tasks.map(async (task) => [task, JSON.parse(await completeText(llm, request("echo\n", { task }))).effort]),
    );

    // Measured: at xhigh a note's first word took 4-8 s; at medium 1-2 s, with notes as good (TASK_PROFILES).
    expect(Object.fromEntries(efforts)).toEqual({
      explain: "medium",
      ask: "medium",
      preview: "medium",
      recap: "medium",
      quiz: "high",
    });
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

describe("createCodexLlm", () => {
  let workDir: string;
  let fakeBin: string;
  // The Codex home DeepRead gives Codex, as data/codex-home is in the app.
  let home: string;

  const request = (user: string): LlmRequest => ({ task: "word", system: "You are a tutor.", user });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "deepread-llm-codex-"));
    fakeBin = join(workDir, "fake-codex");
    home = join(workDir, "codex-home");
    writeFileSync(fakeBin, FAKE_CLAUDE);
    await chmod(fakeBin, 0o755);
    process.env.FAKE_FIXTURES = join(import.meta.dirname, "fixtures");
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("should read the answer from a captured real run", async () => {
    const llm = createCodexLlm({ bin: fakeBin, home });
    expect(await completeText(llm, request("replay\nWhat does ubiquitous mean?"))).toBe(
      "\u201cUbiquitous\u201d means present or found everywhere, like smartphones today.",
    );
  });

  it("should run with DeepRead's instructions, a read-only sandbox and no tools, and send the prompt on stdin", async () => {
    const hugePrompt = "x".repeat(300_000);
    const info = JSON.parse(await completeText(createCodexLlm({ bin: fakeBin, home }), request(`echo\n${hugePrompt}`)));
    expect(info).toMatchObject({ sandbox: "read-only", ignoresUserConfig: true, instructions: "You are a tutor.", lastArg: "-" });
    expect(info.toolsOff).toEqual(expect.arrayContaining(["shell_tool", "unified_exec", "computer_use", "browser_use"]));
    expect(info.prompt).toBe(hugePrompt);
    expectPrivateDirectoryGone(info.cwd);
  });

  it("should run in a Codex home of DeepRead's own, signed in through the reader's, so their AGENTS.md stays out", async () => {
    const llm = createCodexLlm({ bin: fakeBin, home });
    try {
      // Neither reader home exists, as for a reader not signed in yet: the link still goes in, and the real Codex
      // reads it as signed out.
      for (const readerHome of [join(workDir, "reader-codex"), join(workDir, "reader-codex-moved")]) {
        vi.stubEnv("CODEX_HOME", readerHome);
        // Answers run side by side, so all three set up the link at once.
        const answers = await Promise.all(Array.from({ length: 3 }, () => completeText(llm, request("echo\n"))));
        for (const answer of answers) expect(JSON.parse(answer).codexHome).toBe(home);
        expect(readlinkSync(join(home, "auth.json"))).toBe(join(readerHome, "auth.json"));
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should stop at a refused sign-in and say how to sign in, instead of waiting out the retries", async () => {
    const pidFile = join(workDir, "signedout.pid");
    const started = Date.now();
    await expect(completeText(createCodexLlm({ bin: fakeBin, home }), request(`signedout pidfile=${pidFile}\n`))).rejects.toMatchObject({
      kind: "not_logged_in",
      message: expect.stringContaining("codex login"),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });
});
