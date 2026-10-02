#!/usr/bin/env node
// `deepread`: start DeepRead and open it in the browser, or set it up, or update it.
// Plain Node with no dependencies, so it runs before anything is installed. scripts/install.sh runs `setup`,
// which also puts this script on the PATH as the `deepread` command.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.DEEPREAD_PORT ?? 8787);
const ADDRESS = `http://127.0.0.1:${PORT}`;
const MIN_NODE = 24;
// Workspace settings in pnpm-workspace.yaml need pnpm 10.16 or newer.
const MIN_PNPM = [10, 16];

const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const say = (text) => console.log(`${paint("34", "›")} ${text}`);
const good = (text) => console.log(`${paint("32", "✓")} ${text}`);
const warn = (text) => console.log(`${paint("33", "!")} ${text}`);
function fail(text) {
  console.error(`${paint("31", "✗")} ${text}`);
  process.exit(1);
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE) {
    fail(`DeepRead needs Node.js ${MIN_NODE} or newer; this is ${process.versions.node}. Get it from https://nodejs.org`);
  }
}

/** Runs a command in the DeepRead folder with its output shown; stops with `why` if it fails. */
function run(command, args, why) {
  // npx would otherwise end with an "update npm" notice that is not the reader's concern.
  const env = { ...process.env, npm_config_update_notifier: "false" };
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", env });
  if (result.error || result.status !== 0) fail(why);
}

function works(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The installed pnpm if it is new enough, else a fresh copy through npx (which comes with Node). */
function pnpm() {
  const [major = 0, minor = 0] = (works("pnpm") ?? "").split(".").map(Number);
  if (major > MIN_PNPM[0] || (major === MIN_PNPM[0] && minor >= MIN_PNPM[1])) return ["pnpm"];
  return ["npx", "--yes", "pnpm@11"];
}

function installDependencies() {
  const [command, ...prefix] = pnpm();
  // A developer's checkout keeps its test tools; a reader's install only gets what DeepRead needs to run.
  const developer = existsSync(join(ROOT, "node_modules", "vitest"));
  say(developer ? "Installing packages (with developer tools)..." : "Installing packages...");
  run(command, [...prefix, "install", "--frozen-lockfile", ...(developer ? [] : ["--prod"])], "Installing packages failed. Check your internet connection and run: deepread update");
}

function newestChange(path) {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newestChange(join(path, name))));
}

/** Builds the web app if it is missing or older than its sources (after an update, say). */
function build(force = false) {
  const built = join(ROOT, "dist", "index.html");
  const sources = ["src", "shared", "index.html", "vite.config.ts", "package.json"].map((name) => join(ROOT, name));
  if (!force && existsSync(built) && statSync(built).mtimeMs >= Math.max(...sources.map(newestChange))) return;
  say("Building the reader...");
  run(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "warn"], "Building DeepRead failed. Run: deepread update");
}

/** Puts `deepread` in ~/.local/bin, and that folder on the PATH. True when a new terminal is needed to use it. */
function installCommand() {
  if (platform() === "win32") return false;
  const bin = join(homedir(), ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const command = join(bin, "deepread");
  writeFileSync(command, `#!/bin/sh\n# The DeepRead command, written by \`deepread setup\`.\nexec node "${join(ROOT, "scripts", "deepread.mjs")}" "$@"\n`);
  chmodSync(command, 0o755);
  if ((process.env.PATH ?? "").split(delimiter).includes(bin)) return false;

  const shell = basename(process.env.SHELL ?? "");
  const rc = join(homedir(), shell === "zsh" ? ".zshrc" : shell === "bash" ? (platform() === "darwin" ? ".bash_profile" : ".bashrc") : ".profile");
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (!current.includes(".local/bin")) {
    appendFileSync(rc, `\n# Added by DeepRead: puts the \`deepread\` command on your PATH.\nexport PATH="$HOME/.local/bin:$PATH"\n`);
    say(`Added ~/.local/bin to your PATH in ~/${basename(rc)}.`);
  }
  return true;
}

function aiHelpers() {
  const found = [works("claude") && "Claude Code", works("codex") && "Codex"].filter(Boolean);
  if (found.length) {
    good(`AI helper found: ${found.join(" and ")}. Sign in once in a terminal (\`claude\`, or \`codex\`) if you have not yet.`);
    return;
  }
  warn("No AI helper found. Reading and listening work, but to get explanations install one and sign in:");
  console.log("    Claude Code (Claude Pro or Max):   curl -fsSL https://claude.ai/install.sh | bash   then run: claude");
  console.log("    Codex (ChatGPT Plus or Pro):       npm install -g @openai/codex                 then run: codex");
}

async function running() {
  try {
    const response = await fetch(`${ADDRESS}/api/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

function openBrowser() {
  if (process.env.DEEPREAD_NO_BROWSER) return;
  const wsl = platform() === "linux" && /microsoft/i.test(existsSync("/proc/version") ? readFileSync("/proc/version", "utf8") : "");
  const [command, ...args] =
    platform() === "darwin" ? ["open", ADDRESS] : wsl ? ["explorer.exe", ADDRESS] : platform() === "win32" ? ["cmd", "/c", "start", "", ADDRESS] : ["xdg-open", ADDRESS];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function start() {
  checkNode();
  if (!existsSync(join(ROOT, "node_modules"))) fail("DeepRead is not set up yet. Run: deepread setup");
  build();
  if (await running()) {
    good(`DeepRead is already running at ${ADDRESS}`);
    openBrowser();
    return;
  }

  const server = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production", DEEPREAD_API_PORT: String(PORT) },
  });
  let up = false;
  server.on("exit", (code) => {
    if (!up) fail(`DeepRead could not start. If another program uses port ${PORT}, start on another one: DEEPREAD_PORT=8790 deepread`);
    process.exit(code ?? 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));

  for (let tries = 0; tries < 60 && !up; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    up = await running();
  }
  if (!up) {
    server.kill();
    fail("DeepRead did not start in time. Try again, or run: deepread update");
  }
  console.log(`\n  ${paint("1", "DeepRead is open at")} ${paint("4", ADDRESS)}\n  Keep this window open while you read. Press Ctrl+C to stop.\n`);
  openBrowser();
}

function setup() {
  checkNode();
  installDependencies();
  build(true);
  const newTerminal = installCommand();
  good("DeepRead is set up.");
  aiHelpers();
  console.log(`\n  Start it any time with:  ${paint("1", "deepread")}${newTerminal ? "   (in a new terminal window)" : ""}\n`);
}

function update() {
  checkNode();
  say("Getting the latest DeepRead...");
  run("git", ["pull", "--ff-only"], "Could not update. If you changed DeepRead's files yourself, undo those changes and try again.");
  installDependencies();
  build(true);
  good("DeepRead is up to date. Start it with: deepread");
}

const HELP = `DeepRead: read hard books in English, with a tutor in the margin.

  deepread           Start DeepRead and open it in your browser
  deepread update    Get the latest version
  deepread setup     Install packages and the deepread command again
  deepread help      Show this help

  DEEPREAD_PORT=8790 deepread   Use another port (default 8787)
  Your books and notes are kept in ${join(ROOT, "data")}`;

const command = process.argv[2] ?? "start";
if (command === "start") await start();
else if (command === "setup") setup();
else if (command === "update") update();
else if (command === "help" || command === "--help" || command === "-h") console.log(HELP);
else fail(`Unknown command "${command}". Run: deepread help`);
