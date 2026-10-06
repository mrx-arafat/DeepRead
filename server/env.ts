import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/**
 * Loads .env.local, then .env, from the DeepRead folder, and returns the names of the files it found.
 * A file never replaces a variable that is already set, so the shell wins over both and .env.local over .env.
 */
export function loadEnvFiles(root = ROOT): string[] {
  const found: string[] = [];
  for (const name of [".env.local", ".env"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    process.loadEnvFile(path);
    found.push(name);
  }
  return found;
}
