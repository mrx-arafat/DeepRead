// Local PDF figure extraction and optional OCR. No document leaves this process.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_GRAPHICS_OPERATIONS = 100_000;
const MAX_FIGURE_PRIMITIVES = 4096;
const identity = [1, 0, 0, 1, 0, 0];
function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function bounds(rect, matrix) {
  const points = [
    [rect[0], rect[1]],
    [rect[2], rect[1]],
    [rect[0], rect[3]],
    [rect[2], rect[3]],
  ].map(([x, y]) => [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ]);
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
}
const union = (a, b) => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const intersects = (a, b, pad = 0) =>
  a[0] <= b[2] + pad &&
  b[0] <= a[2] + pad &&
  a[1] <= b[3] + pad &&
  b[1] <= a[3] + pad;

/** Replay graphics transforms; PDF.js 6's constructPath includes its local bounding box. */
export function detectFigureRegions(
  operatorList,
  OPS,
  view,
  textItems = [],
  onLimit = () => {},
) {
  let matrix = identity;
  const stack = [],
    regions = [];
  let primitiveCount = 0;
  const paintOps = new Set([
    OPS.stroke,
    OPS.closeStroke,
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ]);
  const add = (rect, kind, stroked = false) => {
    primitiveCount++;
    if (!rect || rect.length !== 4 || !Array.from(rect).every(Number.isFinite))
      return;
    const b = bounds(rect, matrix);
    if (!b.every(Number.isFinite)) return;
    b[0] = Math.max(view[0], b[0]);
    b[1] = Math.max(view[1], b[1]);
    b[2] = Math.min(view[2], b[2]);
    b[3] = Math.min(view[3], b[3]);
    if (b[2] - b[0] < 2 || b[3] - b[1] < 2) return;
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    // Page backgrounds and thin rules are not figures. Raster scans remain eligible.
    if (
      kind === "vector" &&
      (area > 0.75 * (view[2] - view[0]) * (view[3] - view[1]) ||
        Math.min(b[2] - b[0], b[3] - b[1]) < 4)
    )
      return;
    regions.push({ bounds: b, kind, stroked });
  };
  for (
    let i = 0;
    i < Math.min(operatorList.fnArray.length, MAX_GRAPHICS_OPERATIONS) &&
    primitiveCount < MAX_FIGURE_PRIMITIVES;
    i++
  ) {
    const op = operatorList.fnArray[i],
      args = operatorList.argsArray[i] ?? [];
    if (op === OPS.save) stack.push(matrix);
    else if (op === OPS.restore) matrix = stack.pop() ?? identity;
    else if (op === OPS.transform) matrix = multiply(matrix, args);
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push(matrix);
      if (args[0]) matrix = multiply(matrix, args[0]);
    } else if (op === OPS.paintFormXObjectEnd) matrix = stack.pop() ?? identity;
    else if (op === OPS.constructPath && paintOps.has(args[0]))
      add(args[2], "vector", args[0] !== OPS.fill && args[0] !== OPS.eoFill);
    else if (
      [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
      ].includes(op)
    )
      add([0, 0, 1, 1], "raster");
    else if (
      op === OPS.paintInlineImageXObjectGroup ||
      op === OPS.paintImageMaskXObjectGroup
    ) {
      for (const entry of (op === OPS.paintInlineImageXObjectGroup
        ? args[1]
        : args[0]) ?? []) {
        if (primitiveCount >= MAX_FIGURE_PRIMITIVES) break;
        const saved = matrix;
        matrix = multiply(matrix, entry.transform);
        add([0, 0, 1, 1], "raster");
        matrix = saved;
      }
    } else if (op === OPS.paintImageXObjectRepeat) {
      for (
        let j = 0;
        j < (args[3]?.length ?? 0) && primitiveCount < MAX_FIGURE_PRIMITIVES;
        j += 2
      ) {
        const saved = matrix;
        matrix = multiply(matrix, [
          args[1],
          0,
          0,
          args[2],
          args[3][j],
          args[3][j + 1],
        ]);
        add([0, 0, 1, 1], "raster");
        matrix = saved;
      }
    }
  }
  if (
    operatorList.fnArray.length > MAX_GRAPHICS_OPERATIONS ||
    primitiveCount >= MAX_FIGURE_PRIMITIVES
  )
    onLimit();
  // Merge adjacent diagram primitives, then reject ornament-sized regions.
  const merged = [];
  for (const region of regions) {
    let candidate = region;
    for (let i = merged.length - 1; i >= 0; i--)
      if (intersects(candidate.bounds, merged[i].bounds, 4)) {
        candidate = {
          bounds: union(candidate.bounds, merged[i].bounds),
          stroked: candidate.stroked || merged[i].stroked,
          kind:
            candidate.kind === "raster" || merged[i].kind === "raster"
              ? "raster"
              : "vector",
        };
        merged.splice(i, 1);
        i = merged.length;
      }
    merged.push(candidate);
  }
  return merged
    .filter(({ bounds: b, kind, stroked }) => {
      if (
        b[2] - b[0] < 24 ||
        b[3] - b[1] < 24 ||
        (b[2] - b[0]) * (b[3] - b[1]) < 1200
      )
        return false;
      // Filled prose backgrounds would duplicate text. Stroked diagrams retain their native labels.
      const chars = textItems
        .filter((t) => t.x >= b[0] && t.x <= b[2] && t.y >= b[1] && t.y <= b[3])
        .reduce((n, t) => n + t.s.length, 0);
      return kind === "raster" || stroked || chars < 80;
    })
    .map(({ bounds, kind }) => ({ bounds, kind }))
    .sort((a, b) => b.bounds[3] - a.bounds[3] || a.bounds[0] - b.bounds[0]);
}

/** Tesseract word boxes (top-left pixels) -> ordinary parser items (PDF coordinates). */
export function ocrTsvItems(tsv, viewport) {
  const items = [];
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] !== "5") continue;
    const [left, top, width, height, confidence] = cells
      .slice(6, 11)
      .map(Number);
    const s = cells
      .slice(11)
      .join("\t")
      .replace(/[\u0000-\u001f]/g, " ")
      .trim();
    if (
      !s ||
      confidence < 30 ||
      ![left, top, width, height, confidence].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0
    )
      continue;
    const [x, y] = viewport.convertToPdfPoint(left, top + height);
    const [x2, y2] = viewport.convertToPdfPoint(left + width, top);
    // Existing layout heuristics support horizontal text; rotated scans keep the page picture.
    if (x2 <= x || y2 <= y) continue;
    items.push({ s, x, y, w: x2 - x, size: y2 - y });
  }
  return items;
}

export async function runLocalOcr(
  png,
  { timeoutMs = 15_000, language = "eng", executable = "tesseract" } = {},
) {
  if (!/^[a-zA-Z0-9_+]+$/.test(language))
    throw new Error("Invalid OCR language.");
  const dir = await mkdtemp(join(tmpdir(), "deepread-ocr-"));
  try {
    const file = join(dir, "page.png");
    await writeFile(file, png);
    return await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          "--ocr",
          file,
          language,
          executable,
          String(timeoutMs),
        ],
        {
          timeout: timeoutMs + 2_000,
          killSignal: "SIGKILL",
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) {
            const issue = new Error(
              error.code === 127
                ? "Local OCR is unavailable; install Tesseract and its language data."
                : error.killed || error.code === 124
                  ? "Local OCR timed out."
                  : "Local OCR could not read this page.",
            );
            issue.code =
              error.code === 127
                ? "ocr_unavailable"
                : error.killed || error.code === 124
                  ? "ocr_timeout"
                  : "ocr_failed";
            reject(issue);
          } else resolve(stdout);
        },
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A parse asks for OCR on every figure; once Tesseract is missing it stays missing, so later calls fail at once with
 *  the same error instead of each starting a watchdog process that cannot succeed. `unavailable` holds that error. */
export function ocrRunnerForOneParse(runner = runLocalOcr) {
  const run = async (png, options) => {
    if (run.unavailable) throw run.unavailable;
    try {
      return await runner(png, options);
    } catch (error) {
      if (error?.code === "ocr_unavailable") run.unavailable = error;
      throw error;
    }
  };
  run.unavailable = null;
  return run;
}

// pdf.js ImageKind values and the row count putBinaryImageData paints at a time (pdfjs-dist 6.3.289).
const RGB_24BPP = 2;
const RGBA_32BPP = 3;
const CHUNK_ROWS = 16;
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * pdfjs-dist 6.3.289 paints an RGB image 16 rows at a time, and the tail loop of its RGB to RGBA conversion starts at
 * the image's first byte instead of the chunk's, so every chunk walks all the bytes before it (fixed upstream in
 * src/shared/image_utils.js). For a 1600x1200 photo that is about 100 ms of writes that land past the chunk and are
 * dropped. Handed the same pixels as RGBA, pdf.js copies them instead. The one visible quirk of the old loop is kept:
 * in a last, partial chunk whose pixel count is not a multiple of 4, the final 1 to 3 pixels repeat pixels from the
 * top of the image. Anything unusual is left for pdf.js to paint itself.
 * SHORTCUT: mirrors pdfjs-dist 6.3.289 exactly; when pdfjs-dist is upgraded past the upstream fix, the pixel test in
 * pdfVisuals.test.ts fails on that quirk, and this whole workaround should be deleted rather than adjusted.
 */
export function rgbImageAsRgba(image) {
  if (!littleEndian || image?.kind !== RGB_24BPP || image.bitmap) return image;
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return image;
  if (!(data instanceof Uint8ClampedArray || data instanceof Uint8Array) || data.byteOffset !== 0 || data.length !== width * height * 3) return image;
  const pixels = width * height;
  const rgba = new Uint8ClampedArray(pixels * 4);
  const out = new Uint32Array(rgba.buffer);
  // Three little-endian words hold four pixels: R1G1B1R2 G2B2R3G3 B3R4G4B4.
  const src = new Uint32Array(data.buffer, 0, data.length >> 2);
  let p = 0;
  for (let w = 0; w + 2 < src.length; w += 3, p += 4) {
    const a = src[w], b = src[w + 1], c = src[w + 2];
    out[p] = a | 0xff000000;
    out[p + 1] = (a >>> 24) | (b << 8) | 0xff000000;
    out[p + 2] = (b >>> 16) | (c << 16) | 0xff000000;
    out[p + 3] = (c >>> 8) | 0xff000000;
  }
  for (let s = p * 3; p < pixels; p++, s += 3) out[p] = data[s] | (data[s + 1] << 8) | (data[s + 2] << 16) | 0xff000000;
  const lastPixels = width * (height % CHUNK_ROWS);
  if (height > CHUNK_ROWS && lastPixels % 4) {
    const start = pixels - lastPixels;
    const whole = lastPixels - (lastPixels % 4);
    for (let t = 0; t < lastPixels % 4; t++) out[start + whole + t] = out[whole + t];
  }
  image.kind = RGBA_32BPP;
  image.data = rgba;
  return image;
}

/** Route RGB images resolved into this pdf.js object store (page.objs, page.commonObjs) through rgbImageAsRgba. */
const convertingStores = new WeakSet();
export function paintRgbImagesAsRgba(objs) {
  if (!objs || typeof objs.resolve !== "function" || convertingStores.has(objs)) return;
  convertingStores.add(objs);
  const resolve = objs.resolve;
  objs.resolve = function (id, data) {
    return resolve.call(this, id, rgbImageAsRgba(data));
  };
}

async function guarded(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error("PDF visual extraction timed out."));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bound rendering to four million pixels, retain figures in their original reading order. */
export async function extractPageVisuals(page, options = {}) {
  return (await drawPageVisuals(page, options)).done;
}

/**
 * The first part of extractPageVisuals: read figure regions, render the page and run page OCR. `done`, already started,
 * crops, encodes and labels the figures; most of that time is PNG encoding off the main thread, so a caller may start on
 * the next page meanwhile. `done` yields at most `candidates` figures of about `pixels` pixels in all, and `labelOcr`
 * says whether it may run local OCR.
 */
export async function drawPageVisuals(page, options = {}) {
  const {
    pageNumber = page.pageNumber,
    textItems = [],
    scanned: requestedScanned = false,
    timeoutMs = 10_000,
    ocrTimeoutMs = 15_000,
    maxFigures = 12,
    ocrLanguage = process.env.DEEPREAD_OCR_LANG || "eng",
    ocr = true,
    images = true,
    forceOcr = false,
    totalBudgetMs = timeoutMs + ocrTimeoutMs,
    ocrRunner = runLocalOcr,
  } = options;
  const deadline = Date.now() + totalBudgetMs;
  const budget = (limit) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("PDF visual extraction timed out.");
    return Math.min(limit, remaining);
  };
  const warnings = [],
    figures = [],
    ocrItems = [];
  const finished = () => ({ candidates: 0, pixels: 0, labelOcr: false, ocrUsed: false, done: Promise.resolve({ figures, ocrItems, warnings, ocrUsed: false }) });
  let scanned = requestedScanned;
  if (!images && !(scanned && ocr))
    return finished();
  const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Images shared by several pages land in the document's store while operator lists are read.
  paintRgbImagesAsRgba(page.commonObjs);
  const operators =
    images || scanned
      ? await guarded(page.getOperatorList(), budget(timeoutMs))
      : { fnArray: [], argsArray: [] };
  const regions = detectFigureRegions(
    operators,
    OPS,
    page.view,
    textItems,
    () =>
      warnings.push(
        `Page ${pageNumber}: figure detection reached its graphics complexity limit.`,
      ),
  );
  if (scanned && textItems.length && !regions.length && !forceOcr)
    scanned = false;
  if (!regions.length && !scanned)
    return finished();
  const { createCanvas } = await import("@napi-rs/canvas");
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(
    scanned ? 2 : 1.5,
    Math.sqrt(4_000_000 / (base.width * base.height)),
    2400 / Math.max(base.width, base.height),
  );
  if (!(scale > 0) || !Number.isFinite(scale))
    throw new Error("Invalid PDF page dimensions.");
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height)),
  );
  // Only from here: the page's images already resolved above came from the operator list and are never painted.
  paintRgbImagesAsRgba(page.objs);
  const task = page.render({
    canvas,
    viewport,
    background: "rgb(255,255,255)",
  });
  await guarded(task.promise, budget(timeoutMs), () => task.cancel());
  if (scanned) {
    const sample = createCanvas(128, 128);
    sample.getContext("2d").drawImage(canvas, 0, 0, 128, 128);
    const pixels = sample.getContext("2d").getImageData(0, 0, 128, 128).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 720) ink++;
    if (ink < 4) return finished();
  }
  if (scanned && ocr) {
    try {
      // Known to be missing: fail before encoding a page-sized PNG nobody will read.
      if (ocrRunner.unavailable) throw ocrRunner.unavailable;
      ocrItems.push(
        ...ocrTsvItems(
          await ocrRunner(await canvas.encode("png"), {
            timeoutMs: Math.max(1, budget(ocrTimeoutMs) - 250),
            language: ocrLanguage,
          }),
          viewport,
        ),
      );
    } catch (error) {
      warnings.push(error.message);
    }
  }
  // A scan is the source page, rather than an illustration between its recovered paragraphs.
  const selected =
    !images || maxFigures <= 0
      ? []
      : scanned
        ? [{ bounds: page.view, kind: "raster" }]
        : regions.slice(0, maxFigures);
  if (!scanned && regions.length > maxFigures)
    warnings.push(`Page ${pageNumber}: kept the first ${maxFigures} figures.`);
  const labelOcr = !scanned && ocr && selected.length > 0 && !ocrRunner.unavailable;
  const pixels = selected.reduce((n, { bounds: b }) => n + (b[2] - b[0]) * (b[3] - b[1]), 0) * scale * scale;
  const done = (async () => {
    for (const { bounds: b } of selected) {
      if (Date.now() >= deadline) {
        warnings.push("PDF visual extraction timed out.");
        break;
      }
      const rect = bounds(b, viewport.transform);
      const x = Math.max(0, Math.floor(Math.min(rect[0], rect[2]))),
        y = Math.max(0, Math.floor(Math.min(rect[1], rect[3])));
      const width = Math.min(
          canvas.width - x,
          Math.ceil(Math.max(rect[0], rect[2])) - x,
        ),
        height = Math.min(
          canvas.height - y,
          Math.ceil(Math.max(rect[1], rect[3])) - y,
        );
      if (width <= 0 || height <= 0) continue;
      const crop = createCanvas(width, height);
      crop
        .getContext("2d")
        .drawImage(canvas, x, y, width, height, 0, 0, width, height);
      const png = await crop.encode("png");
      if (png.length > 2 * 1024 * 1024) {
        warnings.push(
          `Page ${pageNumber}: a figure exceeded the image size limit.`,
        );
        continue;
      }
      let ocrText;
      let alt = scanned
        ? `Original scanned page ${pageNumber}`
        : `Figure on page ${pageNumber}`;
      if (!scanned && ocr && figures.length < 2) {
        try {
          const labels = ocrTsvItems(
            await ocrRunner(png, {
              timeoutMs: Math.max(1, budget(ocrTimeoutMs) - 250),
              language: ocrLanguage,
            }),
            { convertToPdfPoint: (x, y) => [x, height - y] },
          )
            .map((item) => item.s)
            .join(" ");
          if (labels) {
            alt += `: ${labels.slice(0, 1000)}`;
            const nativeWords = new Set(
              textItems
                .filter(
                  (item) =>
                    item.x >= b[0] &&
                    item.x <= b[2] &&
                    item.y >= b[1] &&
                    item.y <= b[3],
                )
                .flatMap(
                  (item) => item.s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
                ),
            );
            const words = labels.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
            if (
              words.filter((word) => nativeWords.has(word)).length <
              words.length * 0.8
            )
              ocrText = labels.slice(0, 1000);
          }
        } catch (error) {
          if (!warnings.includes(error.message)) warnings.push(error.message);
        }
      }
      figures.push({
        type: "image",
        kind: "image",
        text: "",
        page: pageNumber,
        x: b[0],
        y: b[3],
        width: b[2] - b[0],
        height: b[3] - b[1],
        scanned,
        image: {
          src: `data:image/png;base64,${png.toString("base64")}`,
          width,
          height,
          alt,
          ...(ocrText ? { ocrText } : {}),
        },
      });
    }
    return { figures, ocrItems, warnings, ocrUsed: ocrItems.length > 0 };
  })();
  // A caller that timed out never reads it; keep a late failure from becoming an unhandled rejection.
  done.catch(() => {});
  return { candidates: selected.length, pixels, labelOcr, ocrUsed: ocrItems.length > 0, done };
}

// This watchdog runs in its own process: terminating a PDF worker cannot remove its kill timer.
if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.argv[2] === "--ocr"
) {
  const [file, language, executable, budget] = process.argv.slice(3);
  if (
    !file ||
    basename(file) !== "page.png" ||
    dirname(dirname(file)) !== tmpdir() ||
    !/^deepread-ocr-[a-zA-Z0-9]+$/.test(basename(dirname(file))) ||
    !/^[a-zA-Z0-9_+]+$/.test(language ?? "")
  ) {
    throw new Error("Invalid local OCR invocation.");
  }
  execFile(
    executable,
    [file, "stdout", "-l", language, "tsv"],
    {
      timeout: Math.max(1, Number(budget) || 15_000),
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    },
    async (error, stdout) => {
      await rm(dirname(file), { recursive: true, force: true }).catch(() => {});
      if (error)
        process.exitCode =
          error.code === "ENOENT" ? 127 : error.killed ? 124 : 1;
      else process.stdout.write(stdout);
    },
  );
}
