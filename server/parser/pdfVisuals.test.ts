import { describe, expect, it } from "vitest";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  detectFigureRegions,
  extractPageVisuals,
  ocrRunnerForOneParse,
  ocrTsvItems,
  rgbImageAsRgba,
  runLocalOcr,
} from "./pdfVisuals.mjs";

const view = [0, 0, 600, 800];
const tsv =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t40\t100\t80\t20\t96\tReadable\n5\t1\t1\t1\t1\t2\t125\t100\t60\t20\t3\tnoise\n";

describe("PDF figure geometry", () => {
  it("composes nested graphics transforms and restores after a form", () => {
    const regions = detectFigureRegions(
      {
        fnArray: [
          OPS.transform,
          OPS.paintFormXObjectBegin,
          OPS.transform,
          OPS.paintImageXObject,
          OPS.paintFormXObjectEnd,
          OPS.transform,
          OPS.paintImageXObject,
        ],
        argsArray: [
          [1, 0, 0, 1, 10, 20],
          [[1, 0, 0, 1, 40, 100], null],
          [100, 0, 0, 80, 0, 0],
          ["image"],
          [],
          [60, 0, 0, 50, 300, 400],
          ["second"],
        ],
      },
      OPS,
      view,
    );
    expect(regions.map((r) => r.bounds)).toEqual([
      [310, 420, 370, 470],
      [50, 120, 150, 200],
    ]);
  });
  it("combines diagram primitives but excludes backgrounds and decorative rules", () => {
    const regions = detectFigureRegions(
      {
        fnArray: [
          OPS.constructPath,
          OPS.constructPath,
          OPS.constructPath,
          OPS.constructPath,
        ],
        argsArray: [
          [OPS.fill, [], view],
          [OPS.fill, [], [20, 700, 500, 701]],
          [OPS.stroke, [], [50, 300, 150, 350]],
          [OPS.stroke, [], [149, 300, 250, 350]],
        ],
      },
      OPS,
      view,
    );
    expect(regions).toEqual([{ bounds: [50, 300, 250, 350], kind: "vector" }]);
  });
  it("excludes clipping-only paths and bounds highly complex pages", () => {
    expect(
      detectFigureRegions(
        {
          fnArray: [OPS.constructPath],
          argsArray: [[OPS.endPath, [], [50, 300, 250, 400]]],
        },
        OPS,
        view,
      ),
    ).toEqual([]);
    let limited = false;
    const operations = Array.from({ length: 5000 }, () => OPS.constructPath);
    const args = operations.map(() => [OPS.fill, [], [50, 300, 250, 400]]);
    const regions = detectFigureRegions(
      { fnArray: operations, argsArray: args },
      OPS,
      view,
      [],
      () => {
        limited = true;
      },
    );
    expect(limited).toBe(true);
    expect(regions).toEqual([{ bounds: [50, 300, 250, 400], kind: "vector" }]);
  });
  it("supports repeated optimized images", () => {
    expect(
      detectFigureRegions(
        {
          fnArray: [OPS.paintImageXObjectRepeat],
          argsArray: [["i", 100, 80, new Float32Array([40, 100, 300, 500])]],
        },
        OPS,
        view,
      ).map((r) => r.bounds),
    ).toEqual([
      [300, 500, 400, 580],
      [40, 100, 140, 180],
    ]);
  });
  it("keeps labeled stroked diagrams while excluding filled prose backgrounds", () => {
    const text = [
      {
        s: "Native diagram labels ".repeat(6),
        x: 100,
        y: 350,
        w: 100,
        size: 12,
      },
    ];
    const graphics = (paint: number) => ({
      fnArray: [OPS.constructPath],
      argsArray: [[paint, [], [50, 300, 250, 400]]],
    });
    expect(detectFigureRegions(graphics(OPS.stroke), OPS, view, text)).toEqual([
      { bounds: [50, 300, 250, 400], kind: "vector" },
    ]);
    expect(detectFigureRegions(graphics(OPS.fill), OPS, view, text)).toEqual(
      [],
    );
  });
});

describe("local OCR", () => {
  it("maps confident words to parser baseline coordinates", () => {
    expect(
      ocrTsvItems(tsv, { convertToPdfPoint: (x, y) => [x / 2, 800 - y / 2] }),
    ).toEqual([{ s: "Readable", x: 20, y: 740, w: 40, size: 10 }]);
  });
  it("reports missing OCR without uploading anything", async () => {
    await expect(
      runLocalOcr(Buffer.from("unused"), {
        executable: "/nonexistent/deepread-tesseract",
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "ocr_unavailable" });
  });
});

// A small real PDF exercises PDF.js 6 vector detection and native canvas crop rendering.
function pdf(content: string, extraObjects: string[] = []) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /I 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...extraObjects,
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const start = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF`;
  return new Uint8Array(Buffer.from(text));
}

it("renders a real vector figure in place without producing paragraph text", async () => {
  const task = getDocument({
    data: pdf("0.2 0.5 0.8 rg 100 300 200 120 re f"),
    verbosity: 0,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const result = await extractPageVisuals(page, { ocr: false });
    expect(result.figures).toHaveLength(1);
    expect(result.figures[0]).toMatchObject({
      page: 1,
      x: 100,
      y: 420,
      width: 200,
      height: 120,
      text: "",
      image: { width: 300, height: 180 },
    });
    expect(result.figures[0]?.image.src).toMatch(
      /^data:image\/png;base64,iVBOR/,
    );
    expect(result.ocrItems).toEqual([]);
  } finally {
    await task.destroy();
  }
});

it("recovers scanned words and retains the original page figure", async () => {
  const task = getDocument({
    data: pdf("0 0 0 rg 50 650 300 30 re f"),
    verbosity: 0,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const result = await extractPageVisuals(page, {
      scanned: true,
      ocrRunner: async () => tsv,
    });
    expect(result.ocrUsed).toBe(true);
    expect(result.ocrItems[0]).toMatchObject({
      s: "Readable",
      x: 20,
      y: 740,
      w: 40,
      size: 10,
    });
    expect(result.figures[0]?.image.alt).toBe("Original scanned page 1");
  } finally {
    await task.destroy();
  }
});

it("keeps raster artwork and OCR labels together rather than inserting labels into prose", async () => {
  const image =
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n00AAFF>\nendstream";
  const task = getDocument({
    data: pdf("q 200 0 0 120 100 300 cm /I Do Q", [image]),
    verbosity: 0,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const result = await extractPageVisuals(page, {
      ocrRunner: async () => tsv,
    });
    expect(result.figures[0]).toMatchObject({
      x: 100,
      y: 420,
      width: 200,
      height: 120,
      image: { alt: "Figure on page 1: Readable", ocrText: "Readable" },
    });
    expect(result.ocrItems).toEqual([]);
    expect(result.ocrUsed).toBe(false);
    const native = await extractPageVisuals(page, {
      textItems: [{ s: "Readable", x: 120, y: 350, w: 50, size: 12 }],
      ocrRunner: async () => tsv,
    });
    expect(native.figures[0]?.image.ocrText).toBeUndefined();
    const longText = await extractPageVisuals(page, {
      ocrRunner: async () => tsv.replace("Readable", "word ".repeat(500)),
    });
    expect(longText.figures[0]?.image.ocrText).toHaveLength(1000);
  } finally {
    await task.destroy();
  }
});

it("skips blank scanned pages and can OCR without retaining images", async () => {
  const task = getDocument({ data: pdf(""), verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1);
    const result = await extractPageVisuals(page, {
      scanned: true,
      ocrRunner: async () => {
        throw new Error("Blank pages must not run OCR");
      },
    });
    expect(result).toEqual({
      figures: [],
      ocrItems: [],
      warnings: [],
      ocrUsed: false,
    });
  } finally {
    await task.destroy();
  }
  const drawn = getDocument({
    data: pdf("0 0 0 rg 50 650 300 30 re f"),
    verbosity: 0,
  });
  try {
    const page = await (await drawn.promise).getPage(1);
    const result = await extractPageVisuals(page, {
      scanned: true,
      images: false,
      ocrRunner: async () => tsv,
    });
    expect(result.ocrItems[0]?.s).toBe("Readable");
    expect(result.figures).toEqual([]);
  } finally {
    await drawn.destroy();
  }
});

it("hands pdf.js RGB images as RGBA with exactly the pixels it would paint itself", async () => {
  // 5x21: one full 16-row chunk and a 25-pixel last chunk, where pdf.js 6.3.289 repeats a top pixel at the end.
  const [width, height] = [5, 21];
  const rgb = Uint8ClampedArray.from({ length: width * height * 3 }, (_, i) => (i * 37 + 11) & 255);
  const hex = Buffer.from(rgb).toString("hex");
  const task = getDocument({
    data: pdf(`q ${width} 0 0 ${height} 0 ${800 - height} cm /I Do Q`, [
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${hex.length + 1} >>\nstream\n${hex}>\nendstream`,
    ]),
    verbosity: 0,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(600, 800);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport: page.getViewport({ scale: 1 }) }).promise;
    const painted = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    const converted = rgbImageAsRgba({ kind: 2, width, height, data: rgb });
    expect(converted.kind).toBe(3);
    expect(Buffer.from(converted.data)).toEqual(Buffer.from(painted));
  } finally {
    await task.destroy();
  }
});

it("starts no further OCR once Tesseract is missing", async () => {
  let calls = 0;
  const run = ocrRunnerForOneParse(async () => {
    calls++;
    throw Object.assign(new Error("Local OCR is unavailable; install Tesseract and its language data."), { code: "ocr_unavailable" });
  });
  for (let page = 0; page < 3; page++) await expect(run(Buffer.from("png"), {})).rejects.toThrow("Local OCR is unavailable");
  expect(calls).toBe(1);
  expect(run.unavailable?.message).toMatch("Local OCR is unavailable");
});
