import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderSourcePageIsolated } from "./source-page.ts";

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
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe("original source page rendering", () => {
  let directory: string;
  const write = async (name: string, content: Buffer | string) => {
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "deepread-source-page-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("retains the full page, original text, and vector table geometry", async () => {
    const path = await write(
      "formatted.pdf",
      onePagePdf(
        400,
        600,
        "BT /F1 24 Tf 40 500 Td (Original book typography) Tj ET 0.2 0.5 0.8 rg 100 200 200 100 re f 0 0 0 RG 2 w 100 250 m 300 250 l S",
      ),
    );
    const result = await renderSourcePageIsolated(path, 1);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("image/png");
    expect(result!.data.slice(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const image = await loadImage(Buffer.from(result!.data));
    expect([image.width, image.height]).toEqual([1600, 2400]);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    expect(
      Array.from(context.getImageData(800, 1400, 1, 1).data).slice(0, 3),
    ).toEqual([0, 0, 0]);
    expect(
      Array.from(context.getImageData(800, 1500, 1, 1).data).slice(0, 3),
    ).toEqual([51, 128, 204]);
    const textPixels = context.getImageData(150, 320, 1200, 120).data;
    let ink = 0;
    for (let index = 0; index < textPixels.length; index += 4)
      if (textPixels[index]! < 150) ink++;
    expect(ink).toBeGreaterThan(500);
    expect(Array.from(context.getImageData(5, 5, 1, 1).data)).toEqual([
      255, 255, 255, 255,
    ]);
  }, 20_000);

  it("bounds even oversized square pages to four million pixels", async () => {
    const path = await write(
      "large.pdf",
      onePagePdf(10000, 10000, "0 0 0 rg 100 100 100 100 re f"),
    );
    const result = await renderSourcePageIsolated(path, 1);
    expect([result?.width, result?.height]).toEqual([2000, 2000]);
  }, 20_000);

  it("returns no page for missing, invalid, or out-of-range input", async () => {
    expect(
      await renderSourcePageIsolated(join(directory, "missing.pdf"), 1),
    ).toBeNull();
    expect(
      await renderSourcePageIsolated(await write("broken.pdf", "not a PDF"), 1),
    ).toBeNull();
    const path = await write("one.pdf", onePagePdf(400, 600, ""));
    expect(await renderSourcePageIsolated(path, 2)).toBeNull();
    expect(await renderSourcePageIsolated(path, 0)).toBeNull();
    expect(await renderSourcePageIsolated(path, 1.5)).toBeNull();
  }, 20_000);

  it("terminates the renderer when the time budget expires", async () => {
    const path = await write("timeout.pdf", onePagePdf(400, 600, ""));
    const started = Date.now();
    expect(await renderSourcePageIsolated(path, 1, 1)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("refuses excess concurrent renders while the two worker slots are occupied", async () => {
    const path = await write("concurrent.pdf", onePagePdf(400, 600, ""));
    const first = renderSourcePageIsolated(path, 1);
    const second = renderSourcePageIsolated(path, 1);
    expect(await renderSourcePageIsolated(path, 1)).toBeNull();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result?.type === "image/png")).toBe(true);
    expect(await renderSourcePageIsolated(path, 1)).not.toBeNull();
  }, 20_000);
});
