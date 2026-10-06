// Wires the real implementations together and starts the server. Tests use createApp with fakes instead.
import { serve } from "@hono/node-server";
import { join, resolve } from "node:path";
import { formatBytes } from "../shared/bytes.ts";
import { createAi } from "./ai.ts";
import { createApp } from "./app.ts";
import { checkEncryptionKey, createEncryptedStore, refuseEncryptedObjects } from "./encrypted-store.ts";
import { createOpenRouter } from "./openrouter.ts";
import { renderCover } from "./cover.ts";
import type { Accounts } from "./deps.ts";
import { loadEnvFiles } from "./env.ts";
import { createLibrary } from "./library.ts";
import type { Library } from "./library.ts";
import { parsePdf } from "./parser/index.ts";
import { createProfiles, MAX_NAME_CHARS, MAX_PASSKEY_CHARS } from "./profiles.ts";
import { sessionKey } from "./session-token.ts";
import { loadSessionSecret } from "./sessions.ts";
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
// Set: everyone picks a profile and signs in with its code, and the admin's code is this. Unset: one library, no sign-in.
const adminPasskey = process.env.ADMIN_PASSKEY ?? "";
// Below this a passkey that opens every profile is easy to guess.
const STRONG_PASSKEY_CHARS = 12;

/** Stops with the reason when the storage settings cannot work, rather than failing at the first upload. */
async function openStore(): Promise<{ config: StorageConfig; store: ObjectStore }> {
  try {
    const config = readStorageConfig(process.env);
    const raw = config.kind === "local" ? createLocalStore(dataDir) : await (await import("./storage-r2.ts")).openR2Store(config);
    await checkEncryptionKey(raw, config.encryptionKey);
    // Without the key, an encrypted object is refused with the setting to check, never served as a book.
    const store = config.encryptionKey ? createEncryptedStore(raw, config.encryptionKey) : refuseEncryptedObjects(raw);
    return { config, store };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The sentence already names the setting to check; a stack trace would only bury it.
    console.error(`DeepRead could not open the place your books are kept. ${reason}`);
    process.exit(1);
  }
}

const { config: storage, store } = await openStore();
// The admin's OpenRouter key and model (.env, or saved on the admin page): the API model the admin can give to readers.
const openrouter = createOpenRouter({ dataDir });
const llm = createAi({ dataDir, openrouter });
// Settles which AI tool answers before the first request, so cache keys name the right model.
const ai = await llm.status();
const translator = createQuickTranslate({ cacheFile: join(dataDir, "translate-cache.json") });

/** Profiles mode: reads profiles.json (making the admin's profile, moving books from before profiles), or stops with why. */
async function openAccounts(): Promise<Accounts> {
  if (adminPasskey.length > MAX_PASSKEY_CHARS) {
    console.error(`ADMIN_PASSKEY is longer than ${MAX_PASSKEY_CHARS} characters, so signing in would never accept it. Choose a shorter one.`);
    process.exit(1);
  }
  const adminName = (process.env.ADMIN_NAME ?? "").trim().slice(0, MAX_NAME_CHARS) || "Admin";
  const profiles = createProfiles({ store, dataDir, limit: storage.limit, adminPasskey, adminName });
  try {
    await profiles.open();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`DeepRead could not open the profiles. ${reason}`);
    process.exit(1);
  }
  return { profiles, sessionKey: sessionKey(await loadSessionSecret(dataDir), adminPasskey) };
}

const readers = adminPasskey ? { accounts: await openAccounts() } : { library: createLibrary(dataDir, { store, limit: storage.limit }) };
const { accounts } = readers;

/** Every library there is: the one, or each profile's. */
async function allLibraries(): Promise<Library[]> {
  if (!readers.accounts) return [readers.library];
  const { profiles } = readers.accounts;
  return (await profiles.list()).map((profile) => profiles.library(profile.id));
}

const app = createApp({
  ...readers,
  parsePdf,
  renderCover,
  llm,
  openrouter,
  quickTranslate: translator.translate,
  webRoot: production ? resolve(import.meta.dirname, "../dist") : undefined,
  remoteKey: process.env.DEEPREAD_REMOTE_KEY || undefined,
});

// Bound to loopback on purpose: other devices reach it only through the tunnel, which accessGuard checks.
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`DeepRead API listening on http://127.0.0.1:${info.port} (data: ${dataDir})`);
  if (envFiles.length > 0) console.log(`Settings from ${envFiles.join(" and ")}.`);
  const where =
    storage.kind === "r2" ? `the R2 bucket ${storage.bucket}${storage.prefix ? ` (in ${storage.prefix})` : ""}` : "the data folder";
  console.log(`Books are kept in ${where}${storage.limit === null ? "." : `, up to ${formatBytes(storage.limit)}.`}`);
  if (storage.encryptionKey) console.log("Books are encrypted at rest.");
  if (accounts) void logProfiles(accounts);
  const helper = ai.providers.find((provider) => provider.id === ai.active);
  console.log(
    helper
      ? `Explanations by ${helper.name}${helper.detail ? ` (${helper.detail})` : ""}.`
      : "No AI helper found (Claude Code, Codex or an API key): reading works, explanations do not.",
  );
  if (accounts) console.log("Each reader uses the AI helpers the admin gives them, on the admin page.");
  // Books added before covers were kept get theirs now, in the background, while the app already answers.
  void addMissingCovers();
});

async function logProfiles({ profiles }: Accounts): Promise<void> {
  const count = (await profiles.list()).length;
  console.log(`Profiles are on: ${count} profile${count === 1 ? "" : "s"}.`);
  if (adminPasskey.length < STRONG_PASSKEY_CHARS) {
    console.warn(`ADMIN_PASSKEY is weak: it opens every profile, so make it at least ${STRONG_PASSKEY_CHARS} characters long.`);
  }
}

async function addMissingCovers(): Promise<void> {
  try {
    // One library at a time: each draws its covers one book at a time too, so this never loads the computer.
    for (const each of await allLibraries()) await each.addMissingCovers(renderCover);
  } catch (error) {
    console.warn("could not look for the covers of older books:", error);
  }
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  llm.close();
  await translator.flush();
  // The last wrong code is saved before the process goes, so stopping the server never lifts a lock.
  await accounts?.profiles.flush();
  server.close();
  // Open SSE streams would keep the server alive; they are being cancelled, so do not wait for them.
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
