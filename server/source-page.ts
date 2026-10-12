// The original PDF page for readers who need its tables, equations, typography, or exact figure placement.
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

import type {
  SourcePageText,
  SourcePageTextRun,
} from "../shared/source-page.ts";
import { runLocalOcr } from "./parser/pdfVisuals.mjs";

export type SourcePageImage = {
  data: Uint8Array<ArrayBuffer>;
  type: "image/png";
  width: number;
  height: number;
  text?: SourcePageText;
};

const TIMEOUT_MS = 20_000;
const MAX_ACTIVE_RENDERERS = 2;
let activeRenderers = 0;
const MAX_EDGE = 2400;
const MAX_PIXELS = 4_000_000;
const MAX_PDF_BYTES = 300 * 1024 * 1024;
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_RUNS = 20_000;
const MAX_TEXT_CHARACTERS = 200_000;
const OCR_TIMEOUT_MS = 6_000;

type NativeTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  dir?: string;
  hasEOL?: boolean;
};
type NativeTextStyle = {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
  fontFamily?: string;
};

function transform(a: number[], b: number[]): number[] {
  return [
    a[0]! * b[0]! + a[2]! * b[1]!,
    a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!,
    a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
    a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ];
}

/** Native PDF text geometry follows the same ascent and rotation formulas as PDF.js's TextLayer. */
export function nativeSourcePageRuns(
  content: { items: unknown[]; styles: Record<string, NativeTextStyle> },
  viewport: { transform: number[]; scale: number },
  width: number,
  height: number,
): SourcePageTextRun[] {
  const runs: SourcePageTextRun[] = [],
    seen = new Set<string>();
  let characters = 0;
  for (const value of content.items.slice(0, MAX_TEXT_RUNS * 2)) {
    const item = value as Partial<NativeTextItem>;
    if (
      typeof item.str !== "string" ||
      !item.str.trim() ||
      !item.transform ||
      item.transform.length !== 6 ||
      !item.transform.every(Number.isFinite)
    )
      continue;
    const text = item.str
      .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "")
      .slice(0, MAX_TEXT_CHARACTERS - characters);
    if (!text) break;
    const style = content.styles[item.fontName ?? ""] ?? {};
    const matrix = transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(matrix[2]!, matrix[3]!);
    let angle = Math.atan2(matrix[1]!, matrix[0]!);
    if (style.vertical) angle += Math.PI / 2;
    const ascentRatio = Number.isFinite(style.ascent)
      ? style.ascent!
      : Number.isFinite(style.descent)
        ? 1 + style.descent!
        : 0.8;
    const ascent = ascentRatio * fontHeight;
    const x = matrix[4]! + ascent * Math.sin(angle),
      y = matrix[5]! - ascent * Math.cos(angle);
    const runWidth =
      (style.vertical ? (item.height ?? 0) : (item.width ?? 0)) *
      viewport.scale;
    if (
      ![x, y, fontHeight, runWidth, angle].every(Number.isFinite) ||
      fontHeight <= 0 ||
      runWidth <= 0
    )
      continue;
    // Allow rotated text near the page edges, but exclude wholly off-page text.
    if (
      Math.abs(x / width) > 2 ||
      Math.abs(y / height) > 2 ||
      runWidth / width > 2 ||
      fontHeight / height > 1
    )
      continue;
    const radius = Math.hypot(runWidth, fontHeight);
    if (
      x + radius < 0 ||
      y + radius < 0 ||
      x - radius > width ||
      y - radius > height
    )
      continue;
    const key = `${text}|${x.toFixed(1)}|${y.toFixed(1)}|${angle.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const family = style.fontFamily?.toLowerCase() ?? "";
    runs.push({
      text,
      x: x / width,
      y: y / height,
      width: runWidth / width,
      height: fontHeight / height,
      fontSize: fontHeight / height,
      angle: (angle * 180) / Math.PI,
      dir: item.dir === "rtl" ? "rtl" : "ltr",
      ...(item.hasEOL ? { hasEOL: true } : {}),
      fontFamily: family.includes("mono")
        ? "monospace"
        : family.includes("sans")
          ? "sans-serif"
          : "serif",
      source: "native",
    });
    characters += text.length;
    if (runs.length >= MAX_TEXT_RUNS || characters >= MAX_TEXT_CHARACTERS)
      break;
  }
  return runs;
}

/** OCR boxes are already in rendered image coordinates, including the PDF page's displayed rotation. */
export function ocrSourcePageRuns(
  tsv: string,
  width: number,
  height: number,
): SourcePageTextRun[] {
  if (!(width > 0 && height > 0)) return [];
  const runs: SourcePageTextRun[] = [];
  let characters = 0;
  for (const row of tsv.split(/\r?\n/).slice(1, MAX_TEXT_RUNS * 4 + 1)) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] !== "5") continue;
    const [x, y, w, h, confidence] = cells.slice(6, 11).map(Number);
    if (
      ![x, y, w, h, confidence].every(Number.isFinite) ||
      x! < 0 ||
      y! < 0 ||
      w! <= 0 ||
      h! <= 0 ||
      confidence! < 30 ||
      confidence! > 100 ||
      x! + w! > width + 1 ||
      y! + h! > height + 1
    )
      continue;
    const text = cells
      .slice(11)
      .join("\t")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, MAX_TEXT_CHARACTERS - characters);
    if (!text) continue;
    runs.push({
      text,
      x: x! / width,
      y: y! / height,
      width: w! / width,
      height: h! / height,
      fontSize: h! / height,
      angle: 0,
      dir: "ltr",
      fontFamily: "sans-serif",
      source: "ocr",
    });
    characters += text.length;
    if (runs.length >= MAX_TEXT_RUNS || characters >= MAX_TEXT_CHARACTERS)
      break;
  }
  return runs;
}

/** Preserve native runs and add only OCR words whose centres are not already covered by native text. */
export function mergeSourcePageRuns(
  native: SourcePageTextRun[],
  ocr: SourcePageTextRun[],
  width: number,
  height: number,
): SourcePageTextRun[] {
  const cells = new Map<number, Array<[number, number, number, number]>>(),
    broad: Array<[number, number, number, number]> = [];
  const cell = (value: number) =>
    Math.max(0, Math.min(31, Math.floor(value * 32)));
  for (const run of native) {
    const angle = (run.angle * Math.PI) / 180,
      w = run.width * width,
      h = run.height * height;
    const dx = w * Math.cos(angle),
      dy = w * Math.sin(angle),
      hx = -h * Math.sin(angle),
      hy = h * Math.cos(angle);
    const xs = [0, dx, hx, dx + hx].map((x) => run.x + x / width),
      ys = [0, dy, hy, dy + hy].map((y) => run.y + y / height);
    const box: [number, number, number, number] = [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
    const x0 = cell(box[0]),
      x1 = cell(box[2]),
      y0 = cell(box[1]),
      y1 = cell(box[3]);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) {
      if (broad.length < 128) broad.push(box);
      continue;
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const key = y * 32 + x;
        const entries = cells.get(key) ?? [];
        if (entries.length < 512) entries.push(box);
        cells.set(key, entries);
      }
  }
  const added: SourcePageTextRun[] = [];
  let characters = native.reduce((count, run) => count + run.text.length, 0);
  for (const run of ocr) {
    const x = run.x + run.width / 2,
      y = run.y + run.height / 2;
    const boxes = [...(cells.get(cell(y) * 32 + cell(x)) ?? []), ...broad];
    if (
      boxes.some(
        (box) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3],
      )
    )
      continue;
    if (
      native.length + added.length >= MAX_TEXT_RUNS ||
      characters + run.text.length > MAX_TEXT_CHARACTERS
    )
      break;
    added.push(run);
    characters += run.text.length;
  }
  // Insert OCR words by their page position while retaining native content order and rotated groups.
  const before = new Map<number, SourcePageTextRun[]>();
  const positions = native
    .map((run, index) => ({ y: run.y, index }))
    .sort((a, b) => a.y - b.y || a.index - b.index);
  const rows = new Map<
    number,
    Array<{ run: SourcePageTextRun; index: number }>
  >();
  native.forEach((run, index) => {
    if (Math.abs(run.angle % 360) > 2 || run.dir !== "ltr") return;
    const key = Math.floor(run.y * 128),
      entries = rows.get(key) ?? [];
    entries.push({ run, index });
    rows.set(key, entries);
  });
  for (const entries of rows.values())
    entries.sort((a, b) => a.run.x - b.run.x || a.index - b.index);
  for (const run of added) {
    // Words missing between two native chunks on one baseline belong before the right chunk.
    let sameRow: number | undefined;
    const tolerance = run.height * 0.5;
    for (
      let row = Math.floor((run.y - tolerance) * 128);
      row <= Math.floor((run.y + tolerance) * 128);
      row++
    ) {
      const entries = rows.get(row);
      if (!entries) continue;
      let left = 0,
        right = entries.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (entries[middle]!.run.x < run.x) left = middle + 1;
        else right = middle;
      }
      for (
        let index = left;
        index < Math.min(entries.length, left + 16);
        index++
      ) {
        const candidate = entries[index]!;
        if (
          Math.abs(candidate.run.y - run.y) <=
          Math.min(candidate.run.height, run.height) * 0.5
        ) {
          sameRow =
            sameRow === undefined
              ? candidate.index
              : Math.min(sameRow, candidate.index);
          break;
        }
      }
    }
    let low = 0,
      high = positions.length;
    const y = run.y + run.height * 0.5;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle]!.y <= y) low = middle + 1;
      else high = middle;
    }
    const anchor = sameRow ?? positions[low]?.index ?? native.length;
    const group = before.get(anchor) ?? [];
    group.push(run);
    before.set(anchor, group);
  }
  const runs: SourcePageTextRun[] = [];
  for (let index = 0; index <= native.length; index++) {
    runs.push(...(before.get(index) ?? []));
    if (index < native.length) runs.push(native[index]!);
  }
  return runs;
}

async function withinBudget<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Selectable text extraction timed out.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function hasUsableNativeText(runs: SourcePageTextRun[]): boolean {
  const text = runs.map((run) => run.text).join(" ");
  if (!text.match(/[\p{L}\p{N}]/gu)?.length) return false;
  return (
    (text.match(/[\uFFFD\uFFFE\uFFFF\uE000-\uF8FF]/g)?.length ?? 0) <
    Math.max(1, text.length * 0.05)
  );
}

async function renderSourcePage(
  pdfPath: string,
  pageNumber: number,
  deadline: number,
  onImage: (image: SourcePageImage) => void,
): Promise<SourcePageImage | null> {
  // Check before allocating the input buffer. This is the same upload size ceiling as the library.
  const file = await stat(pdfPath);
  if (!file.isFile() || file.size > MAX_PDF_BYTES) return null;
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const assets = `${dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))}/`;
  const bytes = await readFile(pdfPath);
  const task = getDocument({
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    standardFontDataUrl: `${assets}standard_fonts/`,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    wasmUrl: `${assets}wasm/`,
  });
  try {
    const pdf = await task.promise;
    if (pageNumber > pdf.numPages) return null;
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    if (
      !(base.width > 0 && base.height > 0) ||
      !Number.isFinite(base.width * base.height)
    )
      return null;
    const scale = Math.min(
      MAX_EDGE / Math.max(base.width, base.height),
      Math.sqrt(MAX_PIXELS / (base.width * base.height)),
    );
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas = createCanvas(width, height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
      background: "rgb(255,255,255)",
      recordImages: true,
    }).promise;
    const png = await canvas.encode("png");
    if (png.length > MAX_PNG_BYTES) return null;
    const image: SourcePageImage & { text: SourcePageText } = {
      data: new Uint8Array(png),
      type: "image/png",
      width,
      height,
      text: {
        width,
        height,
        runs: [],
        warning: "Selectable text is unavailable for this page.",
      },
    };
    // Preserve the rendered page even if text extraction or OCR exceeds the remaining worker budget.
    onImage(image);
    try {
      const remaining = () => Math.max(1, deadline - Date.now() - 250);
      const content = await withinBudget(
        page.getTextContent(),
        Math.min(3000, remaining()),
      );
      const nativeRuns = nativeSourcePageRuns(content, viewport, width, height);
      const usableNative = hasUsableNativeText(nativeRuns) ? nativeRuns : [];
      image.text = { width, height, runs: usableNative };
      const corners = page.imageCoordinates as ArrayLike<number> | null;
      let raster = false;
      for (
        let at = 0;
        corners && at + 5 < Math.min(corners.length, 120_000);
        at += 6
      ) {
        const xs = [corners[at]!, corners[at + 2]!, corners[at + 4]!],
          ys = [corners[at + 1]!, corners[at + 3]!, corners[at + 5]!];
        if (
          (Math.max(...xs) - Math.min(...xs)) *
            (Math.max(...ys) - Math.min(...ys)) >=
          0.002
        ) {
          raster = true;
          break;
        }
      }
      if (!usableNative.length || raster) {
        const sample = createCanvas(128, 128);
        sample.getContext("2d").drawImage(canvas, 0, 0, 128, 128);
        const rgba = sample.getContext("2d").getImageData(0, 0, 128, 128).data;
        let ink = 0;
        for (let at = 0; at < rgba.length; at += 4)
          if (rgba[at]! + rgba[at + 1]! + rgba[at + 2]! < 720) ink++;
        if (ink >= 4) {
          const ocr = ocrSourcePageRuns(
            await runLocalOcr(png, {
              timeoutMs: Math.min(OCR_TIMEOUT_MS, remaining()),
              language: process.env.DEEPREAD_OCR_LANG || "eng",
            }),
            width,
            height,
          );
          const runs = mergeSourcePageRuns(usableNative, ocr, width, height);
          image.text = {
            width,
            height,
            runs,
            ...(!runs.length
              ? {
                  warning:
                    "No selectable text could be recognized on this page.",
                }
              : {}),
          };
        }
      }
    } catch (error) {
      image.text.warning =
        error instanceof Error
          ? error.message
          : "Selectable text is unavailable for this page.";
    }
    return image;
  } finally {
    await task.destroy();
  }
}

/** Render a full source page locally. Hard worker termination bounds even synchronous PDF.js failures. */
export function renderSourcePageIsolated(
  pdfPath: string,
  pageNumber: number,
  timeoutMs = TIMEOUT_MS,
): Promise<SourcePageImage | null> {
  if (
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    return Promise.resolve(null);
  if (activeRenderers >= MAX_ACTIVE_RENDERERS) return Promise.resolve(null);
  activeRenderers++;
  return new Promise((resolve) => {
    const deadline = Date.now() + Math.min(timeoutMs, TIMEOUT_MS);
    let worker: Worker;
    try {
      worker = new Worker(new URL(import.meta.url), {
        workerData: { deepreadSourcePage: { pdfPath, pageNumber, deadline } },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    } catch {
      activeRenderers--;
      resolve(null);
      return;
    }
    let settled = false;
    let rendered: SourcePageImage | null = null;
    const done = (page: SourcePageImage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep the capacity slot until the worker exits and releases its native canvas memory.
      void worker.terminate().then(
        () => resolve(page),
        () => resolve(page),
      );
    };
    const timer = setTimeout(
      () => done(rendered),
      Math.min(timeoutMs, TIMEOUT_MS),
    );
    worker.on(
      "message",
      (message: {
        preview?: SourcePageImage;
        text?: SourcePageText;
        page?: null;
      }) => {
        if (message.preview) rendered = message.preview;
        else if (message.text && rendered) {
          rendered.text = message.text;
          done(rendered);
        } else done(rendered);
      },
    );
    worker.once("error", () => done(rendered));
    worker.once("exit", () => {
      activeRenderers--;
      done(rendered);
    });
  });
}

if (
  !isMainThread &&
  typeof workerData?.deepreadSourcePage?.pdfPath === "string"
) {
  const { pdfPath, pageNumber, deadline } = workerData.deepreadSourcePage as {
    pdfPath: string;
    pageNumber: number;
    deadline: number;
  };
  renderSourcePage(pdfPath, pageNumber, deadline, (preview) =>
    parentPort?.postMessage({ preview }, [preview.data.buffer]),
  ).then(
    (page) =>
      parentPort?.postMessage(page ? { text: page.text } : { page: null }),
    () => parentPort?.postMessage({ page: null }),
  );
}
