// Open in ChatGPT: the admin's choice of whether readers get the button that hands a deep dive to an outside chat,
// kept in the data folder like the translation settings.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HandoffSettings } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { isRecord } from "./http.ts";

const SETTINGS_FILE = "handoff.json";
const DEFAULT_SETTINGS: HandoffSettings = { enabled: true };

/** The admin's choice for Open in ChatGPT, which holds for every reader. */
export type HandoffSettingsStore = {
  /** What the admin chose, or the default until they choose: on. */
  get(): HandoffSettings;
  /** Keeps what the admin chose; the caller has checked the fields. */
  save(patch: Partial<HandoffSettings>): Promise<HandoffSettings>;
};

/** What the file holds; a field that is missing or makes no sense is the default. */
function readSettings(file: string): HandoffSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) console.warn(`${SETTINGS_FILE} is unreadable, so Open in ChatGPT starts as it does by default:`, error);
    return DEFAULT_SETTINGS;
  }
  const saved = isRecord(parsed) ? parsed : {};
  return { enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_SETTINGS.enabled };
}

export function createHandoffSettings(dataDir: string): HandoffSettingsStore {
  const file = join(dataDir, SETTINGS_FILE);
  // Only this process writes the file, so what is in memory is what is on disk.
  let current = readSettings(file);
  // One save at a time, so a slow disk cannot let an older choice land last.
  let saving: Promise<unknown> = Promise.resolve();
  return {
    get: () => current,
    save(patch) {
      const run = saving.then(async () => {
        const next = { ...current, ...patch };
        await mkdir(dataDir, { recursive: true });
        await writeFileAtomic(file, `${JSON.stringify(next)}\n`);
        current = next;
        return next;
      });
      saving = run.catch(() => {});
      return run;
    },
  };
}
