import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "e2e/fixtures/problems-of-philosophy.pdf");
const journeys = {
  "ux01-controls-matrix": { fixture: true },
  "ux01-position-matrix": { fixture: true },
  "ux02-profile-recovery": { passkey: "ux02-profile-test-code-2026" },
  notebook: { fixture: true },
  "notebook-saved-answer": { fixture: true },
  "notebook-missing-source": { fixture: true },
  "notebook-shared": { passkey: "shared-notebook-test-code-2026" },
};
const children = new Set();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    for (const child of children) child.kill("SIGTERM");
  });
}

function home() {
  const bin = fileURLToPath(import.meta.url).replace(homedir(), "~");
  console.log(`bin: ${bin}\ndescription: Run a browser journey with temporary local DeepRead data`);
  console.log(`journeys[${Object.keys(journeys).length}]{name,setup}:`);
  for (const [name, setup] of Object.entries(journeys)) console.log(`  ${name},${setup.passkey ? "profiles" : "fixture book"}`);
  console.log("help: pnpm e2e:run <journey>");
}

// SHORTCUT: probing then releasing a port can race; use socket handoff if parallel runs collide.
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.once("exit", () => children.delete(child));
  let output = "";
  const append = chunk => { output = (output + chunk.toString()).slice(-4000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", append);
  return { child, output: () => output };
}

async function command(commandName, args, timeoutMs = 180000) {
  const running = start(commandName, args, process.env);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    running.child.kill("SIGTERM");
    setTimeout(() => running.child.kill("SIGKILL"), 1000).unref();
  }, timeoutMs);
  try {
    const code = await new Promise((resolve, reject) => {
      running.child.once("error", reject);
      running.child.once("exit", resolve);
    });
    if (timedOut || code !== 0) throw new Error(`${commandName} ${args[args.length - 1]} ${timedOut ? "timed out" : `exited ${code}`}: ${running.output()}`);
  } finally {
    clearTimeout(timer);
  }
}

async function ready(url, processInfo, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) throw new Error(`${label} exited: ${processInfo.output()}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* Wait for the listening socket. */ }
    await delay(100);
  }
  throw new Error(`${label} did not become ready: ${processInfo.output()}`);
}

async function stop(processInfo) {
  if (!processInfo || processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) return;
  const exited = new Promise(resolve => processInfo.child.once("exit", resolve));
  processInfo.child.kill("SIGTERM");
  const timer = setTimeout(() => processInfo.child.kill("SIGKILL"), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function run(name, setup) {
  const dataDir = await mkdtemp(join(tmpdir(), "deepread-e2e-"));
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  const session = `deepread-e2e-${process.pid}-${Date.now()}`;
  const env = { ...process.env, DEEPREAD_STORAGE: "local", DEEPREAD_DATA_DIR: dataDir, DEEPREAD_API_PORT: String(apiPort), ADMIN_NAME: "Owner", ADMIN_PASSKEY: setup.passkey ?? "" };
  delete env.DEEPREAD_REMOTE_KEY;
  let api;
  let web;
  const started = Date.now();
  try {
    process.stderr.write(`Starting isolated ${name} journey...\n`);
    api = start(process.execPath, [join(root, "server/index.ts")], env);
    await ready(`http://127.0.0.1:${apiPort}/api/session`, api, "API");
    if (setup.fixture) {
      const form = new FormData();
      form.append("file", new Blob([await readFile(fixture)], { type: "application/pdf" }), "problems-of-philosophy.pdf");
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/books`, { method: "POST", body: form });
      if (!response.ok) throw new Error(`fixture upload returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    web = start(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], env);
    await ready(`http://127.0.0.1:${webPort}/`, web, "Vite");
    await command("playwright-cli", [`-s=${session}`, "open", `http://127.0.0.1:${webPort}`], 30000);
    await command("playwright-cli", [`-s=${session}`, "run-code", "--filename", `e2e/${name}.js`]);
    console.log(`journey: ${name}\nstatus: passed\nduration_ms: ${Date.now() - started}`);
  } finally {
    await command("playwright-cli", [`-s=${session}`, "close"], 10000).catch(() => {});
    await stop(web);
    await stop(api);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const [name, ...extra] = process.argv.slice(2);
if (!name) home();
else if (["-v", "-V", "--version"].includes(name) && extra.length === 0) console.log("0.1.0");
else if (name === "--help" && extra.length === 0) home();
else if (extra.length || !Object.hasOwn(journeys, name)) {
  console.log(`error: unknown journey ${name}${extra.length ? ` (unexpected arguments: ${extra.join(" ")})` : ""}`);
  home();
  process.exitCode = 2;
} else {
  await run(name, journeys[name]).catch(error => {
    console.log(`journey: ${name}\nstatus: failed\nerror: ${JSON.stringify(error.message)}`);
    process.exitCode = 1;
  });
}
