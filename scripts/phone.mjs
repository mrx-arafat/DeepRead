// `pnpm phone`: run DeepRead and share it through a Cloudflare quick tunnel so you can read on your phone.
// The app has no login, so the API only lets a phone in after it opens the printed link, which carries a
// secret key. The key is kept in data/remote-key (git-ignored) so the link stays the same between runs;
// the tunnel name changes every run.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const keyFile = join(root, "data", "remote-key");

function remoteKey() {
  if (process.env.DEEPREAD_REMOTE_KEY) return process.env.DEEPREAD_REMOTE_KEY;
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  mkdirSync(join(root, "data"), { recursive: true });
  const key = randomBytes(18).toString("base64url");
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  return key;
}

if (spawnSync("cloudflared", ["--version"]).error) {
  console.error("cloudflared is not installed. On macOS: brew install cloudflared");
  process.exit(1);
}

const key = remoteKey();
const children = [];
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const app = spawn("pnpm", ["dev"], { cwd: root, stdio: "inherit", env: { ...process.env, DEEPREAD_REMOTE_KEY: key } });
children.push(app);
app.on("exit", (code) => {
  console.error(`DeepRead stopped (exit ${code}).`);
  stop();
});

// An empty config file: otherwise a named tunnel's ~/.cloudflared/config.yml takes over the quick tunnel's
// routing and every request gets that config's catch-all 404.
const emptyConfig = join(root, "data", "cloudflared-empty.yml");
writeFileSync(emptyConfig, "");
const tunnel = spawn(
  "cloudflared",
  ["tunnel", "--no-autoupdate", "--config", emptyConfig, "--url", "http://127.0.0.1:5173"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
children.push(tunnel);
let shown = false;
const watch = (chunk) => {
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk))?.[0];
  if (!url || shown) return;
  shown = true;
  console.log(`\n  Open this on your phone (it unlocks DeepRead on that device):\n\n  ${url}/api/unlock?key=${key}\n`);
  console.log("  Anyone with this link can use DeepRead and your Claude usage. Do not share it. Ctrl+C stops it.\n");
};
tunnel.stdout.on("data", watch);
tunnel.stderr.on("data", watch);
tunnel.on("exit", (code) => {
  console.error(`The tunnel stopped (exit ${code}).`);
  stop();
});
