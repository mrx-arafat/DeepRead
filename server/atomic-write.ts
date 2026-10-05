import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

/** Write via a temp file in the same directory, then rename, so readers never see half a file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "w");
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
