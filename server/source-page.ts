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

export type SourcePageImage = {
  data: Uint8Array<ArrayBuffer>;
  type: "image/png";
  width: number;
  height: number;
};

const TIMEOUT_MS = 20_000;
const MAX_ACTIVE_RENDERERS = 2;
let activeRenderers = 0;
const MAX_EDGE = 2400;
const MAX_PIXELS = 4_000_000;
const MAX_PDF_BYTES = 300 * 1024 * 1024;
const MAX_PNG_BYTES = 16 * 1024 * 1024;

async function renderSourcePage(
  pdfPath: string,
  pageNumber: number,
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
    }).promise;
    const png = await canvas.encode("png");
    if (png.length > MAX_PNG_BYTES) return null;
    return { data: new Uint8Array(png), type: "image/png", width, height };
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
    let worker: Worker;
    try {
      worker = new Worker(new URL(import.meta.url), {
        workerData: { deepreadSourcePage: { pdfPath, pageNumber } },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    } catch {
      activeRenderers--;
      resolve(null);
      return;
    }
    let settled = false;
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
    const timer = setTimeout(() => done(null), Math.min(timeoutMs, TIMEOUT_MS));
    worker.once("message", (message: { page: SourcePageImage | null }) =>
      done(message.page),
    );
    worker.once("error", () => done(null));
    worker.once("exit", () => {
      activeRenderers--;
      done(null);
    });
  });
}

if (
  !isMainThread &&
  typeof workerData?.deepreadSourcePage?.pdfPath === "string"
) {
  const { pdfPath, pageNumber } = workerData.deepreadSourcePage as {
    pdfPath: string;
    pageNumber: number;
  };
  renderSourcePage(pdfPath, pageNumber).then(
    (page) => parentPort?.postMessage({ page }, page ? [page.data.buffer] : []),
    () => parentPort?.postMessage({ page: null }),
  );
}
