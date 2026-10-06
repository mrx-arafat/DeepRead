// `pnpm storage:migrate`: copies the books in the data folder into the R2 bucket set in .env.local.
// Books already in the bucket are left as they are, and nothing on this computer is changed or removed.
// Run it while DeepRead is stopped: DeepRead clears away a half-copied book when it starts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatBytes } from "../shared/bytes.ts";
import { copyBooks } from "../server/copy-books.ts";
import { loadEnvFiles } from "../server/env.ts";
import { readStorageConfig } from "../server/storage-config.ts";
import { openR2Store } from "../server/storage-r2.ts";
import { createLocalStore } from "../server/storage.ts";

const OUTCOMES = { copied: "copied", skipped: "already in the bucket", noRoom: "no room left under the limit" } as const;

async function main(): Promise<void> {
  loadEnvFiles();
  const config = readStorageConfig(process.env);
  if (config.kind !== "r2") {
    throw new Error("Set DEEPREAD_STORAGE=r2 and the R2 settings in .env.local first (.env.example shows how).");
  }
  const dataDir = resolve(process.env.DEEPREAD_DATA_DIR ?? "./data");
  const target = await openR2Store(config);
  const tempDir = await mkdtemp(join(tmpdir(), "deepread-migrate-"));
  console.log(`Copying the books in ${dataDir} into the R2 bucket ${config.bucket} (${config.prefix || "whole bucket"})...`);
  try {
    const report = await copyBooks(createLocalStore(dataDir), target, {
      tempDir,
      limit: config.limit,
      onBook: (id, outcome, bytes) => console.log(`  ${id} (${formatBytes(bytes)}): ${OUTCOMES[outcome]}`),
    });
    const total = report.copied.length + report.skipped.length + report.noRoom.length;
    console.log(
      total === 0
        ? "There are no books in the data folder."
        : `Done: ${report.copied.length} copied, ${report.skipped.length} already there, ${report.noRoom.length} without room. The books on this computer are unchanged.`,
    );
    if (report.noRoom.length > 0) process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
