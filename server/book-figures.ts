import { createHash } from "node:crypto";
import type { ParsedBook } from "../shared/types.ts";

export const FIGURE_NAME = /^[0-9a-f]{64}\.png$/;
const PNG_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_FIGURE_BYTES = 8 * 1024 * 1024;
const MAX_BOOK_FIGURE_BYTES = 64 * 1024 * 1024;

/** Keep image bytes out of chapter responses; content hashes also deduplicate repeated figures. */
export function separateFigures(parsed: ParsedBook): {
  book: ParsedBook;
  figures: Map<string, Buffer>;
} {
  const figures = new Map<string, Buffer>();
  let bytes = 0;
  const book = {
    ...parsed,
    chapters: parsed.chapters.map((chapter) => ({
      ...chapter,
      blocks: chapter.blocks.map((block) => {
        if (block.type !== "image" || !block.image) return block;
        const match = PNG_URL.exec(block.image.src);
        if (!match || match[1]!.length > Math.ceil(MAX_FIGURE_BYTES / 3) * 4)
          throw new Error("Invalid book figure");
        const data = Buffer.from(match[1]!, "base64");
        if (
          data.length > MAX_FIGURE_BYTES ||
          !data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ) {
          throw new Error("Invalid book figure PNG");
        }
        const name = `${createHash("sha256").update(data).digest("hex")}.png`;
        if (!figures.has(name)) {
          bytes += data.length;
          if (bytes > MAX_BOOK_FIGURE_BYTES)
            throw new Error("Book figures exceed their storage budget");
          figures.set(name, data);
        }
        return { ...block, image: { ...block.image, src: `figures/${name}` } };
      }),
    })),
  };
  return { book, figures };
}
