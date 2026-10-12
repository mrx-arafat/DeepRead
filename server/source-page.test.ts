import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mergeSourcePageRuns,
  nativeSourcePageRuns,
  ocrSourcePageRuns,
  renderSourcePageIsolated,
} from "./source-page.ts";

function onePagePdf(
  width: number,
  height: number,
  content: string,
  raster?: { width: number; height: number; hex: string },
): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${raster ? "/XObject << /I 6 0 R >>" : ""} >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  if (raster)
    objects.push(
      `<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${raster.hex.length + 1} >>\nstream\n${raster.hex}>\nendstream`,
    );
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
    expect(result!.text?.runs[0]).toMatchObject({
      text: "Original book typography",
      x: 0.1,
      fontSize: 0.04,
      angle: 0,
      source: "native",
    });
    expect(result!.text?.runs[0]?.y).toBeGreaterThan(0.12);
    expect(result!.text?.runs[0]?.y).toBeLessThan(0.17);
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
  it("retains actual rotated PDF text geometry", async () => {
    const path = await write(
      "rotated.pdf",
      onePagePdf(
        400,
        600,
        "BT /F1 24 Tf 0 1 -1 0 300 200 Tm (Rotated text) Tj ET",
      ),
    );
    const result = await renderSourcePageIsolated(path, 1);
    expect(result?.text?.runs[0]).toMatchObject({
      text: "Rotated text",
      angle: -90,
      fontSize: 0.04,
      source: "native",
    });
  }, 20_000);

  let installed = false;
  try {
    execFileSync("tesseract", ["--version"], { stdio: "ignore" });
    installed = true;
  } catch {}
  it.skipIf(!installed)(
    "adds scanned body text beside a native footer without duplicating native words",
    async () => {
      const scan = createCanvas(700, 150),
        ctx = scan.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 700, 150);
      ctx.fillStyle = "black";
      ctx.font = "32px sans-serif";
      ctx.fillText("Scanned body remains selectable", 20, 80);
      const pixels = ctx.getImageData(0, 0, 700, 150).data,
        rgb = Buffer.alloc(700 * 150 * 3);
      for (let index = 0; index < 700 * 150; index++) {
        rgb[index * 3] = pixels[index * 4]!;
        rgb[index * 3 + 1] = pixels[index * 4 + 1]!;
        rgb[index * 3 + 2] = pixels[index * 4 + 2]!;
      }
      const raster = {
        width: 700,
        height: 150,
        hex: deflateSync(rgb).toString("hex"),
      };
      const path = await write(
        "mixed-scan.pdf",
        onePagePdf(
          400,
          600,
          "q 350 0 0 75 25 300 cm /I Do Q BT /F1 18 Tf 40 40 Td (Native footer) Tj ET",
          raster,
        ),
      );
      const result = await renderSourcePageIsolated(path, 1);
      const runs = result?.text?.runs ?? [];
      expect(
        runs
          .filter((run) => run.source === "ocr")
          .map((run) => run.text)
          .join(" "),
      ).toContain("Scanned body remains selectable");
      expect(runs.filter((run) => run.text.includes("Native"))).toHaveLength(1);
      expect(runs[0]?.source).toBe("ocr");
      expect(runs.at(-1)?.text).toBe("Native footer");
    },
    20_000,
  );
});

const tsv =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t40\t100\t80\t20\t96\tScanned\n";
it("validates OCR boxes and keeps displayed image coordinates without PDF rotation loss", () => {
  const bad =
    tsv +
    "5\t1\t1\t1\t1\t2\t-1\t20\t40\t20\t99\tOutside\n5\t1\t1\t1\t1\t3\t20\t20\t40\t20\t2\tNoise\n5\t1\t1\t1\t1\t4\tNaN\t20\t40\t20\t90\tMalformed\n";
  expect(ocrSourcePageRuns(bad, 400, 600)).toEqual([
    {
      text: "Scanned",
      x: 0.1,
      y: 1 / 6,
      width: 0.2,
      height: 1 / 30,
      fontSize: 1 / 30,
      angle: 0,
      dir: "ltr",
      fontFamily: "sans-serif",
      source: "ocr",
    },
  ]);
});
it("deduplicates native overprints and rejects absurd native text geometry", () => {
  const item = {
    str: "Native",
    transform: [20, 0, 0, 20, 40, 100],
    width: 60,
    height: 20,
    fontName: "f",
  };
  const content = {
    items: [item, item, { ...item, transform: [20, 0, 0, 1e10, 40, 100] }],
    styles: { f: { ascent: 0.8, fontFamily: "sans-serif" } },
  };
  expect(
    nativeSourcePageRuns(
      content,
      { transform: [1, 0, 0, -1, 0, 600], scale: 1 },
      400,
      600,
    ),
  ).toHaveLength(1);
});
it("places newly recognized body words before a native footer and suppresses covered OCR", () => {
  const footer = {
    text: "Footer",
    x: 0.1,
    y: 0.8,
    width: 0.3,
    height: 0.04,
    fontSize: 0.04,
    angle: 0,
    dir: "ltr" as const,
    source: "native" as const,
  };
  const body = { ...footer, text: "Body", y: 0.3, source: "ocr" as const };
  expect(
    mergeSourcePageRuns(
      [footer],
      [body, { ...footer, source: "ocr" }],
      400,
      600,
    ).map((run) => run.text),
  ).toEqual(["Body", "Footer"]);
});

it("inserts missing OCR words within a native baseline while preserving native column order", () => {
  const base = {
    text: "Alpha",
    x: 0.1,
    y: 0.2,
    width: 0.1,
    height: 0.03,
    fontSize: 0.03,
    angle: 0,
    dir: "ltr" as const,
    source: "native" as const,
  };
  const charlie = { ...base, text: "Charlie", x: 0.7 };
  const nextLeft = { ...base, text: "Left next", y: 0.5 };
  const bravo = { ...base, text: "Bravo", x: 0.4, source: "ocr" as const };
  expect(
    mergeSourcePageRuns([base, nextLeft, charlie], [bravo], 400, 600).map(
      (run) => run.text,
    ),
  ).toEqual(["Alpha", "Left next", "Bravo", "Charlie"]);
  expect(
    mergeSourcePageRuns([base, charlie], [bravo], 400, 600).map(
      (run) => run.text,
    ),
  ).toEqual(["Alpha", "Bravo", "Charlie"]);
});
