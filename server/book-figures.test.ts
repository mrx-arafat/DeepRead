import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedBook } from "../shared/types.ts";
import { separateFigures } from "./book-figures.ts";
import { createLibrary, StorageFullError } from "./library.ts";
import { createLocalStore } from "./storage.ts";
import { createEncryptedStore } from "./encrypted-store.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const fixture = (src = `data:image/png;base64,${png}`): ParsedBook => ({
  title: "Figures",
  author: null,
  pageCount: 1,
  warnings: [],
  chapters: [
    {
      id: "c1",
      title: "One",
      startPage: 1,
      endPage: 1,
      blocks: [
        {
          id: "c1-b1",
          type: "paragraph",
          text: "Before the picture.",
          page: 1,
        },
        ...[2, 3].map((n) => ({
          id: `c1-b${n}`,
          type: "image" as const,
          text: "",
          page: 1,
          image: { src, width: 1, height: 1, alt: "Figure" },
        })),
      ],
    },
  ],
});

describe("book figure assets", () => {
  it("deduplicates PNGs without changing source blocks or text offsets", () => {
    const input = fixture();
    const { book, figures } = separateFigures(input);
    expect(figures.size).toBe(1);
    expect([...figures.values()][0]).toEqual(Buffer.from(png, "base64"));
    expect(book.chapters[0]!.blocks[1]!.image!.src).toMatch(
      /^figures\/[0-9a-f]{64}\.png$/,
    );
    expect(book.chapters[0]!.blocks[0]).toEqual(input.chapters[0]!.blocks[0]);
    expect(input.chapters[0]!.blocks[1]!.image!.src).toContain(
      "data:image/png",
    );
  });

  it.each([
    "https://example.com/picture.png",
    "data:image/svg+xml;base64,AAAA",
    "data:image/png;base64,AAAA",
  ])("refuses an unexpected source or non-PNG bytes: %s", (src) => {
    expect(() => separateFigures(fixture(src))).toThrow(/Invalid book figure/);
  });

  it("stores figures encrypted with the book, counts their bytes, and removes them with it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepread-figure-store-"));
    try {
      const raw = createLocalStore(dir);
      const store = createEncryptedStore(raw, Buffer.alloc(32, 1));
      const library = createLibrary(dir, { store });
      const uploadPath = await library.newUploadPath("Figures");
      await writeFile(uploadPath, "%PDF-test");
      const { id } = await library.add({
        uploadPath,
        sha256: "a".repeat(64),
        parsed: fixture(),
        cover: null,
      });
      const name = (await library.book(
        id,
      ))!.chapters[0]!.blocks[1]!.image!.src.split("/")[1]!;
      expect(await library.figure(id, name)).toEqual(
        new Uint8Array(Buffer.from(png, "base64")),
      );
      const sealed = await readFile(join(dir, "books", id, "figures", name));
      expect(sealed.subarray(0, 6).toString("latin1")).toBe("\0DRENC");
      const stored = await store.list(`books/${id}/`);
      expect(
        stored.filter((file) => file.key.includes("/figures/")),
      ).toHaveLength(1);
      expect((await library.usage()).used).toBe(
        stored.reduce((sum, file) => sum + file.size, 0),
      );
      expect(await library.figure(id, "source.pdf")).toBeNull();
      await library.remove(id);
      expect(await library.figure(id, name)).toBeNull();
      expect(await store.list(`books/${id}/`)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an import when figures would exceed the storage limit before writing the book", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepread-figure-limit-"));
    try {
      const library = createLibrary(dir, { limit: 1 });
      const uploadPath = await library.newUploadPath("Figures");
      await writeFile(uploadPath, "%PDF-test");
      await expect(
        library.add({
          uploadPath,
          sha256: "b".repeat(64),
          parsed: fixture(),
          cover: null,
        }),
      ).rejects.toBeInstanceOf(StorageFullError);
      expect(await library.list()).toEqual([]);
      expect((await library.usage()).used).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
