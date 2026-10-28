// Summarise a parsed book JSON (parsePdf.mjs --compact output or /api/books/<id>/chapters/* joined): what the reader will get.
//   node e2e/perf/fixture-summary.mjs <book.json>
import { readFile, stat } from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  console.error("usage: node e2e/perf/fixture-summary.mjs <book.json>");
  process.exit(2);
}
const book = JSON.parse(await readFile(file, "utf8"));
if (book.error) {
  console.log(`error: ${book.error}\nmessage: ${book.message}`);
  process.exit(1);
}
const counts = book.chapters.map((chapter) => chapter.blocks.length).sort((a, b) => a - b);
const images = book.chapters.flatMap((chapter) => chapter.blocks.filter((block) => block.type === "image"));
const words = book.chapters.reduce((sum, chapter) => sum + chapter.blocks.reduce((n, block) => n + (block.text?.split(/\s+/).filter(Boolean).length ?? 0), 0), 0);
const sizes = new Map();
for (const block of images) sizes.set(`${block.image.width}x${block.image.height}`, (sizes.get(`${block.image.width}x${block.image.height}`) ?? 0) + 1);
console.log(`title: ${book.title}\npages: ${book.pageCount}\nchapters: ${book.chapters.length}\nblocks: ${counts.reduce((a, b) => a + b, 0)}\nblocksPerChapter: min ${counts[0]} median ${counts[counts.length >> 1]} max ${counts.at(-1)}\nwords: ${words}\nimages: ${images.length}${images.length ? ` (${[...sizes].map(([size, n]) => `${size} x${n}`).join(", ")})` : ""}\nimageBytesTotalMB: ${Math.round(images.reduce((sum, block) => sum + block.image.src.length * 0.75, 0) / 1048576 * 10) / 10}\njsonMB: ${Math.round((await stat(file)).size / 1048576 * 100) / 100}\nkinds: ${book.chapters.map((chapter) => chapter.kind).join(",")}\nfirstTitles: ${book.chapters.slice(0, 3).map((chapter) => JSON.stringify(chapter.title)).join(" | ")}\nwarnings: ${JSON.stringify(book.warnings)}`);
