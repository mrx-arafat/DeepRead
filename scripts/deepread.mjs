#!/usr/bin/env node
// `deepread`: start DeepRead and open it in the browser, or set it up, or update it.
// Plain Node with no dependencies, so it runs before anything is installed. scripts/install.sh runs `setup`,
// which also puts this script on the PATH as the `deepread` command.
// Every message here is for someone who has never used a terminal: everyday words, and each problem ends with
// the exact line to copy, on its own line, after a sentence saying what that line does.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Not import.meta.dirname: that needs Node 20.11, and an older Node must still get as far as checkNode's message.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.DEEPREAD_PORT ?? 8787);
const ADDRESS = `http://127.0.0.1:${PORT}`;
const MIN_NODE = 24;
// Workspace settings in pnpm-workspace.yaml need pnpm 10.16 or newer.
const MIN_PNPM = [10, 16];
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/mrx-arafat/DeepRead/main/scripts/install.sh | bash";
const OPENING = process.env.DEEPREAD_NO_BROWSER ? "is ready at" : "is opening in your browser at";

// Whatever this script starts (npx, pnpm, the server, the AI helpers) should run on the Node that is running it,
// not on an older one that comes first on the PATH. USER_PATH keeps the PATH as the reader's terminal had it.
const NODE_DIR = dirname(process.execPath);
const USER_PATH = process.env.PATH ?? "";
process.env.PATH = [NODE_DIR, ...USER_PATH.split(delimiter).filter((folder) => folder && folder !== NODE_DIR)].join(delimiter);

const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const say = (text) => console.log(`${paint("34", "›")} ${text}`);
const good = (text) => console.log(`${paint("32", "✓")} ${text}`);
const warn = (text) => console.log(`${paint("33", "!")} ${text}`);

/** Stops after saying what went wrong; `fix` is [what the line does, the line itself], shown so it can be copied. */
function fail(problem, fix) {
  console.error(`${paint("31", "✗")} ${problem}`);
  if (fix) console.error(`  ${fix[0]}\n\n    ${paint("1", fix[1])}\n`);
  process.exit(1);
}

// The installer starts again from the top and is safe to repeat, and it works even before the `deepread` command exists.
const TRY_AGAIN = ["Check your internet connection, then copy this line into the terminal and press Enter. It tries the whole install again:", INSTALL_COMMAND];

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE) {
    fail(
      `DeepRead needs a newer version of Node.js (the free program it runs on). This computer is using Node.js ${process.versions.node}, at ${process.execPath}.`,
      [`To fix it, copy this line into the terminal and press Enter. It installs Node.js ${MIN_NODE} just for DeepRead and leaves the Node.js you already have alone:`, INSTALL_COMMAND],
    );
  }
}

/** Runs a command in the DeepRead folder with its output shown; stops with `problem` if it fails. */
function run(command, args, problem) {
  // npx would otherwise end with an "update npm" notice that is not the reader's concern.
  const env = { ...process.env, npm_config_update_notifier: "false" };
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", env });
  if (result.error || result.status !== 0) fail(problem, TRY_AGAIN);
}

function works(command, args = ["--version"], env = process.env) {
  const result = spawnSync(command, args, { encoding: "utf8", env });
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
  say(developer ? "Installing the parts DeepRead needs, and the developer tools (about a minute)..." : "Installing the parts DeepRead needs (about a minute)...");
  run(command, [...prefix, "install", "--frozen-lockfile", ...(developer ? [] : ["--prod"])], "DeepRead could not install the parts it needs. This is usually the internet connection.");
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
  say("Getting the reader ready (about a minute)...");
  run(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "warn"], "DeepRead could not get the reader ready.");
}

/**
 * The Node that `deepread` runs on: the installer's pick (DEEPREAD_NODE) when it is a working Node 24 or newer, else the
 * one running setup. The installer's path is the stable one (Homebrew's keeps working after an upgrade); process.execPath is not.
 */
function commandNode() {
  const chosen = process.env.DEEPREAD_NODE;
  // A bare name would be looked up on the PATH again, which is the very thing the command must not do.
  if (!chosen || chosen === process.execPath || !isAbsolute(chosen)) return process.execPath;
  const result = spawnSync(chosen, ["-p", "process.versions.node"], { encoding: "utf8" });
  const major = Number((result.stdout ?? "").split(".")[0]);
  return result.status === 0 && major >= MIN_NODE ? chosen : process.execPath;
}

/** Wraps text in single quotes for /bin/sh, so spaces and quote marks in a path stay part of the path. */
const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The `deepread` command: plain sh that runs this script on `node`, with that Node's folder first on the PATH. */
function commandScript(node) {
  const script = shellQuote(join(ROOT, "scripts", "deepread.mjs"));
  return [
    "#!/bin/sh",
    "# The DeepRead command, written by `deepread setup`. Running setup again rewrites it.",
    "# It runs DeepRead on the Node.js it was set up with, even when another version comes first in your terminal.",
    `PATH=${shellQuote(dirname(node))}"\${PATH:+:$PATH}"`,
    "export PATH",
    "# If that Node was moved or removed (a Homebrew upgrade, say), fall back to the PATH; DeepRead then says what to do.",
    `if [ -x ${shellQuote(node)} ]; then exec ${shellQuote(node)} ${script} "$@"; fi`,
    `exec node ${script} "$@"`,
    "",
  ].join("\n");
}

/** Puts `deepread` in ~/.local/bin, and that folder on the PATH. True when a new terminal is needed to use it. */
function installCommand() {
  if (platform() === "win32") return false;
  const bin = join(homedir(), ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const command = join(bin, "deepread");
  writeFileSync(command, commandScript(commandNode()));
  chmodSync(command, 0o755);
  if (USER_PATH.split(delimiter).includes(bin)) return false;

  const shell = basename(process.env.SHELL ?? "");
  const rc = join(homedir(), shell === "zsh" ? ".zshrc" : shell === "bash" ? (platform() === "darwin" ? ".bash_profile" : ".bashrc") : ".profile");
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (!current.includes(".local/bin")) {
    appendFileSync(rc, `\n# Added by DeepRead: makes the \`deepread\` command work in new terminal windows.\nexport PATH="$HOME/.local/bin:$PATH"\n`);
    say(`Made the deepread command work in new terminal windows (saved in ~/${basename(rc)}).`);
  }
  return true;
}

/**
 * The PATH the server runs with: the current one, then the folders `claude` and `codex` are usually installed in.
 * The Node's own folder is one of them: Codex installed with that Node's npm lands next to it.
 */
function serverPath() {
  const have = (process.env.PATH ?? "").split(delimiter);
  const usual = [NODE_DIR, dirname(commandNode()), join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  return [process.env.PATH, ...usual.filter((folder) => !have.includes(folder) && existsSync(folder))].filter(Boolean).join(delimiter);
}

/** Says how to add Claude Code or Codex, the two programs that can explain the book. */
function explainHowToAddHelper() {
  console.log("  Explanations need Claude Code or Codex, and neither is on this computer yet. Reading and listening work without them.");
  console.log("  To add Claude Code, copy this line into a new terminal window and press Enter. It installs Claude Code:\n");
  console.log(`    ${paint("1", "curl -fsSL https://claude.ai/install.sh | bash")}\n`);
  console.log("  Then open another new terminal window, type  claude  and press Enter to sign in.");
  console.log("  To use Codex instead, run  npm install -g @openai/codex  and then type  codex  to sign in.");
}

function aiHelpers() {
  const env = { ...process.env, PATH: serverPath() };
  const found = [
    works("claude", ["--version"], env) && { name: "Claude Code", command: "claude" },
    works("codex", ["--version"], env) && { name: "Codex", command: "codex" },
  ].filter(Boolean);
  if (!found.length) {
    warn("DeepRead cannot explain words and passages yet.");
    explainHowToAddHelper();
    return;
  }
  good(`Found ${found.map((helper) => helper.name).join(" and ")}. DeepRead can explain words and passages with ${found.length > 1 ? "either one" : "it"}.`);
  console.log(`  If you have not signed in to it yet, open a new terminal window, type  ${found.map((helper) => helper.command).join("  or  ")}  and press Enter.`);
}

async function running() {
  try {
    const response = await fetch(`${ADDRESS}/api/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

/** The AI helper the running server will use: its name, "" when it has none, null when it could not say. */
async function helperInUse() {
  try {
    const response = await fetch(`${ADDRESS}/api/ai/providers`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const { active, providers } = await response.json();
    return providers.find((provider) => provider.id === active)?.name ?? "";
  } catch {
    return null;
  }
}

/** One note on who explains the book. A server started here has already said who, so then only the missing-helper help is added. */
async function noteAiHelper(serverSaidWho) {
  const helper = await helperInUse();
  if (helper === null) return;
  if (helper === "") explainHowToAddHelper();
  else if (!serverSaidWho) console.log(`  Explanations by ${helper}.`);
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
  if (!existsSync(join(ROOT, "node_modules"))) {
    fail("DeepRead is not finished installing.", ["Copy this line into the terminal and press Enter. It installs what is missing:", "deepread setup"]);
  }
  build();
  if (await running()) {
    good(`DeepRead is already running. It ${OPENING} ${ADDRESS}`);
    console.log("  To stop it, press Control+C in the window where you started it.");
    openBrowser();
    await noteAiHelper(false);
    return;
  }

  const server = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PATH: serverPath(), NODE_ENV: "production", DEEPREAD_API_PORT: String(PORT) },
  });
  let up = false;
  server.on("exit", (code) => {
    if (!up) {
      fail(`DeepRead could not start. Another program on this computer is probably already using number ${PORT}, which DeepRead needs.`, [
        "To start DeepRead with a different number, copy this line into the terminal and press Enter:",
        "DEEPREAD_PORT=8790 deepread",
      ]);
    }
    process.exit(code ?? 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));

  for (let tries = 0; tries < 60 && !up; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    up = await running();
  }
  if (!up) {
    server.kill();
    fail("DeepRead took too long to start.", ["Try once more. If it still does not start, copy this line into the terminal and press Enter. It gets the newest version and repairs DeepRead:", "deepread update"]);
  }
  console.log(`\n  ${paint("1", `DeepRead ${OPENING}`)} ${paint("4", ADDRESS)}\n  Keep this window open while you read. To stop DeepRead, press Control+C in this window.\n`);
  openBrowser();
  await noteAiHelper(true);
}

function setup() {
  checkNode();
  installDependencies();
  build(true);
  const newTerminal = installCommand();
  good("DeepRead is set up.");
  aiHelpers();
  console.log(`\n  To start DeepRead, ${newTerminal ? "open a new terminal window, then " : ""}type this and press Enter:\n\n    ${paint("1", "deepread")}\n`);
}

function update() {
  checkNode();
  say("Getting the newest version of DeepRead...");
  run("git", ["pull", "--ff-only"], "DeepRead could not get the newest version. If you edited DeepRead's own files, undo those edits first.");
  installDependencies();
  build(true);
  good("DeepRead is up to date. To start it, type  deepread  and press Enter.");
}

/** Where the books and notes are: the data folder, or the R2 bucket that the shell, .env.local or .env names (as the server reads them). */
function booksPlace() {
  const r2 = (value) => (value ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase() === "r2";
  if (process.env.DEEPREAD_STORAGE !== undefined) return r2(process.env.DEEPREAD_STORAGE) ? "in your Cloudflare R2 bucket" : `in ${join(ROOT, "data")}`;
  for (const name of [".env.local", ".env"]) {
    const path = join(ROOT, name);
    if (!existsSync(path)) continue;
    const setting = /^\s*DEEPREAD_STORAGE\s*=(.*)$/m.exec(readFileSync(path, "utf8"));
    if (setting) return r2(setting[1]) ? `in your Cloudflare R2 bucket (set in ${name})` : `in ${join(ROOT, "data")}`;
  }
  return `in ${join(ROOT, "data")}`;
}

const HELP = `DeepRead: read hard books in English, with a tutor in the margin.

Type one of these in the terminal and press Enter:

  deepread           Start DeepRead (it opens in your browser)
  deepread update    Get the newest version
  deepread setup     Install what DeepRead needs and set up the deepread command again
  deepread help      Show this message

To stop DeepRead, press Control+C in the window where it is running.

If DeepRead says number ${PORT} is busy, start it with a different number:  DEEPREAD_PORT=8790 deepread
Your books and notes are kept ${booksPlace()}`;

const command = process.argv[2] ?? "start";
if (command === "start") await start();
else if (command === "setup") setup();
else if (command === "update") update();
else if (command === "help" || command === "--help" || command === "-h") console.log(HELP);
else fail(`"${command}" is not a DeepRead command.`, ["To see the commands you can use, copy this line into the terminal and press Enter:", "deepread help"]);
