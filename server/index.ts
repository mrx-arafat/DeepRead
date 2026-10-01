// Wires the real implementations together and starts the server. Tests use createApp with fakes instead.
import { serve } from "@hono/node-server";
import { join, resolve } from "node:path";
import { createApp } from "./app.ts";
import { createClaudeLlm } from "./llm.ts";
import { parsePdf } from "./parser/index.ts";
import { createQuickTranslate } from "./translate.ts";

const port = Number(process.env.DEEPREAD_API_PORT ?? 8787);
const dataDir = resolve(process.env.DEEPREAD_DATA_DIR ?? "./data");
const production = process.env.NODE_ENV === "production";

const llm = createClaudeLlm();
const translator = createQuickTranslate({ cacheFile: join(dataDir, "translate-cache.json") });

const app = createApp({
  dataDir,
  parsePdf,
  llm,
  quickTranslate: translator.translate,
  webRoot: production ? resolve(import.meta.dirname, "../dist") : undefined,
  remoteKey: process.env.DEEPREAD_REMOTE_KEY || undefined,
});

// Bound to loopback on purpose: this is a single-user app with no login.
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`DeepRead API listening on http://127.0.0.1:${info.port} (data: ${dataDir})`);
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  llm.close();
  await translator.flush();
  server.close();
  // Open SSE streams would keep the server alive; they are being cancelled, so do not wait for them.
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
