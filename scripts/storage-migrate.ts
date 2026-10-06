// `pnpm storage:migrate`: copies the library in the data folder into the R2 bucket set in .env.local: the books, and when
// profiles are turned on (ADMIN_PASSKEY) the profiles with their books and photos.
// Books already in the bucket are left as they are, and nothing on this computer is changed or removed.
// A bucket that already has profiles keeps them: two lists of profiles are not merged, so none are copied from here.
// Run it while DeepRead is stopped: DeepRead clears away a half-copied book when it starts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatBytes } from "../shared/bytes.ts";
import { copyLibrary } from "../server/copy-books.ts";
import type { CopyReport } from "../server/copy-books.ts";
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
  console.log(`Copying the library in ${dataDir} into the R2 bucket ${config.bucket} (${config.prefix || "whole bucket"})...`);
  try {
    const report = await copyLibrary(createLocalStore(dataDir), target, {
      tempDir,
      limit: config.limit,
      onBook: (id, outcome, bytes, profile) =>
        console.log(`  ${profile ? `${profile.name} / ` : ""}${id} (${formatBytes(bytes)}): ${OUTCOMES[outcome]}`),
    });
    const { profiles } = report;
    for (const profile of profiles.list) if (profile.photo) console.log(`  ${profile.name} / photo: copied`);
    if (profiles.outcome === "refused") {
      console.log(
        "The bucket already has profiles (profiles.json), so none were copied from the data folder. The two lists are not merged: " +
          "to use the ones from this computer, remove profiles.json and profiles/ from the bucket first; to keep the bucket's, leave things as they are.",
      );
    }
    if (profiles.outcome === "unfinished") {
      console.log(
        "Profiles are not listed in the bucket yet: some of their books had no room. Raise the limit and run this again; books already copied are skipped.",
      );
    }
    const shelves: CopyReport[] = [report.books, ...profiles.list.map((profile) => profile.books)];
    const count = (outcome: keyof CopyReport): number => shelves.reduce((sum, shelf) => sum + shelf[outcome].length, 0);
    const total = count("copied") + count("skipped") + count("noRoom");
    console.log(
      total === 0 && profiles.outcome === "none"
        ? "There are no books in the data folder."
        : `Done: ${count("copied")} copied, ${count("skipped")} already there, ${count("noRoom")} without room` +
            `${profiles.outcome === "copied" ? `, ${profiles.list.length} profile${profiles.list.length === 1 ? "" : "s"} copied` : ""}. ` +
            "The books on this computer are unchanged.",
    );
    if (count("noRoom") > 0 || profiles.outcome === "refused") process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
