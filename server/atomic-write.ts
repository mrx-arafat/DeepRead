import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

/**
 * Write via a temp file in the same directory, then rename, so readers never see half a file.
 * `mode` is the file's permissions, set as it is made: a file with a secret in it is never readable by others, not even briefly.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "w", mode);
    try {
      await handle.writeFile(data);
      // Without this a power cut can persist the rename but not the bytes.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
