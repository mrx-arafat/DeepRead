// Wires the real implementations together and starts the server. Tests use createApp with fakes instead.
import { serve } from "@hono/node-server";
import { join, resolve } from "node:path";
import { formatBytes } from "../shared/bytes.ts";
import { createAi } from "./ai.ts";
import { createApp } from "./app.ts";
import { renderCover } from "./cover.ts";
import { loadEnvFiles } from "./env.ts";
import { createLibrary } from "./library.ts";
import { parsePdf } from "./parser/index.ts";
import { readStorageConfig } from "./storage-config.ts";
import type { StorageConfig } from "./storage-config.ts";
import { createLocalStore } from "./storage.ts";
import type { ObjectStore } from "./storage.ts";
import { createQuickTranslate } from "./translate.ts";

// Before anything reads a setting.
const envFiles = loadEnvFiles();

const port = Number(process.env.DEEPREAD_API_PORT ?? 8787);
const dataDir = resolve(process.env.DEEPREAD_DATA_DIR ?? "./data");
const production = process.env.NODE_ENV === "production";

/** Stops with the reason when the storage settings cannot work, rather than failing at the first upload. */
async function openStore(): Promise<{ config: StorageConfig; store: ObjectStore }> {
  try {
    const config = readStorageConfig(process.env);
    if (config.kind === "local") return { config, store: createLocalStore(dataDir) };
    const { openR2Store } = await import("./storage-r2.ts");
    return { config, store: await openR2Store(config) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The sentence already names the setting to check; a stack trace would only bury it.
    console.error(`DeepRead could not open the place your books are kept. ${reason}`);
    process.exit(1);
  }
}

const { config: storage, store } = await openStore();
const llm = createAi({ dataDir });
// Settles which AI tool answers before the first request, so cache keys name the right model.
const ai = await llm.status();
const translator = createQuickTranslate({ cacheFile: join(dataDir, "translate-cache.json") });

const library = createLibrary(dataDir, { store, limit: storage.limit });
const app = createApp({
  library,
  parsePdf,
  renderCover,
  llm,
  quickTranslate: translator.translate,
  webRoot: production ? resolve(import.meta.dirname, "../dist") : undefined,
  remoteKey: process.env.DEEPREAD_REMOTE_KEY || undefined,
});

// Bound to loopback on purpose: this is a single-user app with no login.
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`DeepRead API listening on http://127.0.0.1:${info.port} (data: ${dataDir})`);
  if (envFiles.length > 0) console.log(`Settings from ${envFiles.join(" and ")}.`);
  const where =
    storage.kind === "r2" ? `the R2 bucket ${storage.bucket}${storage.prefix ? ` (in ${storage.prefix})` : ""}` : "the data folder";
  console.log(`Books are kept in ${where}${storage.limit === null ? "." : `, up to ${formatBytes(storage.limit)}.`}`);
  const helper = ai.providers.find((provider) => provider.id === ai.active);
  console.log(helper ? `Explanations by ${helper.name}.` : "No AI helper found (Claude Code or Codex): reading works, explanations do not.");
  // Books added before covers were kept get theirs now, in the background, while the app already answers.
  void library.addMissingCovers(renderCover);
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
