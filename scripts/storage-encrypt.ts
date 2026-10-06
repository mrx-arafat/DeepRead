// `pnpm storage:encrypt`: encrypts, in place, the books and profiles already in the data folder or the R2 bucket set in
// .env.local, with DEEPREAD_ENCRYPTION_KEY. What is encrypted already is skipped, so it is safe to stop and run again.
// Run it while DeepRead is stopped: a change DeepRead saves while an object is being encrypted could be lost.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encryptInPlace } from "../server/encrypted-store.ts";
import { loadEnvFiles } from "../server/env.ts";
import { readStorageConfig } from "../server/storage-config.ts";
import { createLocalStore } from "../server/storage.ts";

async function main(): Promise<void> {
  loadEnvFiles();
  const config = readStorageConfig(process.env);
  if (!config.encryptionKey) {
    throw new Error("Set DEEPREAD_ENCRYPTION_KEY in .env.local first (.env.example shows how to make one).");
  }
  const dataDir = resolve(process.env.DEEPREAD_DATA_DIR ?? "./data");
  const where =
    config.kind === "r2" ? `the R2 bucket ${config.bucket}${config.prefix ? ` (in ${config.prefix})` : ""}` : `the data folder ${dataDir}`;
  const store = config.kind === "local" ? createLocalStore(dataDir) : await (await import("../server/storage-r2.ts")).openR2Store(config);
  const tempDir = await mkdtemp(join(tmpdir(), "deepread-encrypt-"));
  console.log(`Encrypting the library in ${where}...`);
  try {
    const counts = await encryptInPlace(store, config.encryptionKey, {
      tempDir,
      onObject: (key, outcome) => {
        if (outcome === "encrypted") console.log(`  ${key}`);
      },
    });
    console.log(`Done: ${counts.encrypted} encrypted, ${counts.skipped} already encrypted.`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
