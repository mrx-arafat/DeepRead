import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ParsedBook } from "../shared/types.ts";
import { createLibrary } from "./library.ts";
import { createLocalStore } from "./storage.ts";

vi.mock("./source-page.ts", () => ({ renderSourcePageIsolated: async () => ({
  data: new Uint8Array([137, 80, 78, 71]), type: "image/png", width: 600, height: 800,
}) }));

it("bounds PDF materialization before rendering and shares duplicate page requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deepread-source-capacity-"));
  try {
    const raw = createLocalStore(dir);
    let downloads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const library = createLibrary(dir, { store: { ...raw, download: async (key, path) => {
      downloads++; await gate; return raw.download(key, path);
    } } });
    const parsed: ParsedBook = { title: "Source", author: null, warnings: [], pageCount: 3,
      chapters: [{ id: "c1", title: "One", startPage: 1, endPage: 3, blocks: [{ id: "c1-b1", type: "paragraph", text: "Book text.", page: 1 }] }] };
    const uploadPath = await library.newUploadPath("Source"); await writeFile(uploadPath, "%PDF-test");
    const { id } = await library.add({ uploadPath, sha256: "c".repeat(64), parsed, cover: null });
    const first = library.sourcePage(id, 1), duplicate = library.sourcePage(id, 1), second = library.sourcePage(id, 2), busy = library.sourcePage(id, 3);
    await vi.waitFor(() => expect(downloads).toBe(2));
    release();
    const [one, same, two, overflow] = await Promise.all([first, duplicate, second, busy]);
    expect(one).not.toBeNull(); expect(same).toBe(one); expect(two).not.toBeNull(); expect(overflow).toBeNull();
    expect(await library.sourcePage(id, 1)).toBe(one); expect(downloads).toBe(2);
    await library.remove(id); expect(await library.sourcePage(id, 1)).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
