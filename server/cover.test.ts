// The cover decision on what real first pages measure, and the renderer on tiny PDFs written by hand.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCover, renderCover } from "./cover.ts";
import type { PageLook } from "./cover.ts";

describe("isCover", () => {
  // Measured on the first pages of real books (rendered 600 pixels wide); the comment names the page.
  const cases: Array<[string, PageLook, boolean]> = [
    ["a photo printed to the edges (Dark Psychology Secrets)", { aspect: 1.29, ink: 0.96, colour: 0.27, image: 1, words: 0 }, true],
    ["a scanned cover on a white page (No Longer Human)", { aspect: 1.5, ink: 0.68, colour: 0.29, image: 0.69, words: 0 }, true],
    ["a dark cloth board in greys (One Thousand Ways to Make $1000)", { aspect: 1.29, ink: 1, colour: 0, image: 1, words: 0 }, true],
    ["half black, half white with quotes (Principles)", { aspect: 1.31, ink: 0.54, colour: 0.02, image: 1, words: 0 }, true],
    ["coloured type on a white board (The Personal MBA)", { aspect: 1.29, ink: 0.33, colour: 0.3, image: 1, words: 0 }, true],
    ["a white board with a little gold (Secrets of Self-Made Millionaires)", { aspect: 1.29, ink: 0.22, colour: 0.11, image: 1, words: 0 }, true],
    ["a black and white drawing on a white board, drawn as a picture", { aspect: 1.5, ink: 0.3, colour: 0, image: 0.7, words: 8 }, true],
    ["a Project Gutenberg title page with the licence and contents", { aspect: 1.29, ink: 0.057, colour: 0.007, image: 0, words: 175 }, false],
    ["a plain title page (Conversation Casanova Mastery)", { aspect: 1.6, ink: 0.026, colour: 0, image: 0.009, words: 32 }, false],
    ["a contents page of blue links (Banned Money Secrets)", { aspect: 1.29, ink: 0.083, colour: 0.063, image: 0, words: 226 }, false],
    ["a scan of one line of text", { aspect: 1.29, ink: 0.015, colour: 0, image: 0.25, words: 0 }, false],
    ["a blank page", { aspect: 1.29, ink: 0, colour: 0, image: 0, words: 0 }, false],
    ["a dark page full of text", { aspect: 1.29, ink: 1, colour: 0, image: 0, words: 400 }, false],
    ["a light page with a few grey shapes and no picture", { aspect: 1.29, ink: 0.3, colour: 0.01, image: 0, words: 12 }, false],
    ["a slide deck's title slide (Exploits and Rootkits)", { aspect: 0.56, ink: 0.98, colour: 0.96, image: 1, words: 13 }, false],
    ["a square page", { aspect: 1, ink: 0.9, colour: 0.4, image: 1, words: 0 }, false],
  ];

  it.each(cases)("should decide %s", (_label, page, expected) => {
    expect(isCover(page)).toBe(expected);
  });
});

/** A one-page PDF of `width` by `height` points whose page draws `content`, with Helvetica as /F1. */
function onePagePdf(width: number, height: number, content: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, at) => {
    offsets.push(pdf.length);
    pdf += `${at + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const RED = "0.62 0.18 0.2 rg";

describe("renderCover", () => {
  let dir: string;
  const write = async (name: string, bytes: Buffer | string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "deepread-cover-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("should use the cloth cover for the real Project Gutenberg first page", async () => {
    const pdf = fileURLToPath(new URL("../e2e/fixtures/problems-of-philosophy.pdf", import.meta.url));
    expect(await renderCover(pdf)).toBeNull();
  }, 20_000);

  it("should draw a page painted to the edges as a cover about 600 pixels wide", async () => {
    const cover = await renderCover(await write("painted.pdf", onePagePdf(400, 600, `${RED} 0 0 400 600 re f`)));
    expect(cover?.type).toBe("image/webp");
    const image = await loadImage(Buffer.from(cover!.data));
    expect([image.width, image.height]).toEqual([600, 900]);
  }, 20_000);

  it("should trim the white page around a cover printed on it", async () => {
    // A 2:3 board of 320 by 480 points, 40 points in from the sides of a 400 by 600 page.
    const cover = await renderCover(await write("framed.pdf", onePagePdf(400, 600, `${RED} 40 60 320 480 re f`)));
    const image = await loadImage(Buffer.from(cover!.data));
    expect(image.width).toBe(600);
    expect(image.height / image.width).toBeCloseTo(1.5, 1);
  }, 20_000);

  it("should find no cover on a page with a few words of text", async () => {
    const page = "BT /F1 28 Tf 60 480 Td (The Problems of Philosophy) Tj 0 -40 Td (Bertrand Russell) Tj ET";
    expect(await renderCover(await write("title-page.pdf", onePagePdf(400, 600, page)))).toBeNull();
  }, 20_000);

  it("should find no cover on a landscape page, however colourful", async () => {
    expect(await renderCover(await write("slide.pdf", onePagePdf(960, 540, `${RED} 0 0 960 540 re f`)))).toBeNull();
  }, 20_000);

  it("should find no cover, and not fail, when the file is not a readable PDF", async () => {
    expect(await renderCover(await write("broken.pdf", "%PDF-1.4\nthis is not really a pdf"))).toBeNull();
    expect(await renderCover(join(dir, "missing.pdf"))).toBeNull();
  }, 20_000);

  it("should give up on a PDF that takes longer than the time allowed", async () => {
    const path = await write("slow.pdf", onePagePdf(400, 600, `${RED} 0 0 400 600 re f`));
    const started = Date.now();
    expect(await renderCover(path, 1)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 20_000);
});
