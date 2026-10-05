// A book's own cover, taken from page 1 of its PDF when that page is one.
// Drawn in a worker thread that is killed if it overruns: a hostile PDF can hang pdf.js, and a cover is never worth
// a stuck import. Whatever goes wrong, the answer is "no cover", and the library draws one from the title instead.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Canvas } from "@napi-rs/canvas";

export type CoverImage = { data: Uint8Array<ArrayBuffer>; type: "image/webp" | "image/jpeg" };

/** What page 1 looks like. Shares are of the whole page, 0 to 1. */
export type PageLook = {
  /** Height over width. */
  aspect: number;
  /** Painted in something other than the paper. */
  ink: number;
  /** In a clear colour, not black, white or grey. */
  colour: number;
  /** Under the largest picture. */
  image: number;
  /** Words of text on the page. */
  words: number;
};

const COVER_WIDTH = 600;
const TIMEOUT_MS = 20_000;
// Taller than a square and no taller than a paperback: the shelf draws every book 2:3, and a page much wider than
// that (a slide, a square art book) would lose most of itself to the frame.
const MIN_ASPECT = 1.15;
const MAX_ASPECT = 1.8;
// A pixel is ink when one of its channels is this far from the paper's; a pixel is coloured when its channels are
// this far apart. Both are wide enough that JPEG noise and the grey edges of anti-aliased text do not count.
const INK_DISTANCE = 40;
const COLOUR_SPREAD = 48;

/**
 * Whether page 1 is the book's cover. A cover paints most of its page, or at least a good part of it in colour or as
 * a picture, and carries few words. A title page, a licence or a first chapter is black type on white paper.
 * In doubt it says no: a book without its cover gets a cloth one, while a page of text on the shelf looks broken.
 */
export function isCover(page: PageLook): boolean {
  if (page.aspect < MIN_ASPECT || page.aspect > MAX_ASPECT) return false;
  // A page of reading: a cover's title, author and a line of praise come nowhere near this.
  if (page.words > 120) return false;
  if (page.ink >= 0.5) return true;
  // Under this it is type on paper (the plainest measured title page inks 0.06, the lightest cover 0.22).
  if (page.ink < 0.15) return false;
  return page.colour >= 0.05 || page.image >= 0.5;
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Ink and colour on a page drawn as RGBA, and the box to cut the cover out of, when it was printed on a page of its own. */
function measure(rgba: Uint8ClampedArray, width: number, height: number): { ink: number; colour: number; board: Box | null } {
  const pixels = width * height;
  // The paper is the most common colour when it is light and close to grey; otherwise the page is painted all over.
  const counts = new Map<number, number>();
  for (let at = 0; at < rgba.length; at += 4) {
    const key = ((rgba[at]! >> 4) << 8) | ((rgba[at + 1]! >> 4) << 4) | (rgba[at + 2]! >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let commonest = 0;
  let commonestCount = 0;
  for (const [key, count] of counts) if (count > commonestCount) [commonest, commonestCount] = [key, count];
  const sum = [0, 0, 0];
  for (let at = 0; at < rgba.length; at += 4) {
    if ((((rgba[at]! >> 4) << 8) | ((rgba[at + 1]! >> 4) << 4) | (rgba[at + 2]! >> 4)) !== commonest) continue;
    for (let c = 0; c < 3; c++) sum[c]! += rgba[at + c]!;
  }
  const [r, g, b] = sum.map((total) => total / commonestCount) as [number, number, number];
  const light = 0.299 * r + 0.587 * g + 0.114 * b >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 40;
  const paper = light && commonestCount >= 0.25 * pixels ? [r, g, b] : [255, 255, 255];

  let ink = 0;
  let colour = 0;
  const inkByRow = new Uint32Array(height);
  const inkByColumn = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const red = rgba[at]!;
      const green = rgba[at + 1]!;
      const blue = rgba[at + 2]!;
      if (Math.max(Math.abs(red - paper[0]!), Math.abs(green - paper[1]!), Math.abs(blue - paper[2]!)) > INK_DISTANCE) {
        ink++;
        inkByRow[y]!++;
        inkByColumn[x]!++;
      }
      if (Math.max(red, green, blue) - Math.min(red, green, blue) >= COLOUR_SPREAD) colour++;
    }
  }

  // The rows and columns with ink in them; a speck of dust (under 1% of a line) does not count.
  const inked = (lines: Uint32Array, length: number) => (line: number) => lines[line]! > 0.01 * length;
  const rows = Array.from(inkByRow.keys()).filter(inked(inkByRow, width));
  const columns = Array.from(inkByColumn.keys()).filter(inked(inkByColumn, height));
  let board: Box | null = null;
  if (rows.length && columns.length) {
    // One pixel in from each side, so the anti-aliased edge of the board never shows as a pale line.
    const box = { left: columns[0]! + 1, top: rows[0]! + 1, right: columns.at(-1)!, bottom: rows.at(-1)! };
    const boxWidth = box.right - box.left;
    const boxHeight = box.bottom - box.top;
    let inside = 0;
    for (let y = box.top; y < box.bottom; y++) {
      for (let x = box.left; x < box.right; x++) {
        const at = (y * width + x) * 4;
        if (Math.max(Math.abs(rgba[at]! - paper[0]!), Math.abs(rgba[at + 1]! - paper[1]!), Math.abs(rgba[at + 2]! - paper[2]!)) > INK_DISTANCE) inside++;
      }
    }
    // A cover scanned or placed on a white page: one solid, book-shaped block with nothing but paper round it.
    const solid = boxWidth > 0 && inside >= 0.97 * boxWidth * boxHeight;
    const aspect = boxHeight / boxWidth;
    const trimmed = boxWidth < width - 2 || boxHeight < height - 2;
    if (solid && trimmed && boxWidth * boxHeight >= 0.4 * pixels && aspect >= MIN_ASPECT && aspect <= MAX_ASPECT) board = box;
  }
  return { ink: ink / pixels, colour: colour / pixels, board };
}

/** The share of the page under the largest picture, from pdf.js's record of where it drew images (three corners each). */
function largestImage(corners: ArrayLike<number> | null): number {
  let largest = 0;
  for (let at = 0; corners && at + 5 < corners.length; at += 6) {
    const xs = [corners[at]!, corners[at + 2]!, corners[at + 4]!];
    const ys = [corners[at + 1]!, corners[at + 3]!, corners[at + 5]!];
    const width = Math.min(1, Math.max(...xs)) - Math.max(0, Math.min(...xs));
    const height = Math.min(1, Math.max(...ys)) - Math.max(0, Math.min(...ys));
    if (width > 0 && height > 0) largest = Math.max(largest, width * height);
  }
  return largest;
}

async function encode(canvas: Canvas): Promise<CoverImage> {
  try {
    return { data: new Uint8Array(await canvas.encode("webp", 82)), type: "image/webp" };
  } catch {
    return { data: new Uint8Array(await canvas.encode("jpeg", 85)), type: "image/jpeg" };
  }
}

/** Runs in the worker: page 1 of the PDF as a cover image, or null when page 1 is not a cover. */
async function drawCover(pdfPath: string): Promise<CoverImage | null> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  // pdf.js reads fonts, character maps and its image decoders from these folders (paths, with the trailing slash it wants).
  const assets = `${dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))}/`;
  const task = getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    standardFontDataUrl: `${assets}standard_fonts/`,
    cMapUrl: `${assets}cmaps/`,
    wasmUrl: `${assets}wasm/`,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const aspect = viewport.height / viewport.width;
    // Checked before drawing anything, so a freakishly shaped page never asks for a giant canvas.
    if (!(aspect >= MIN_ASPECT && aspect <= MAX_ASPECT)) return null;
    const scaled = page.getViewport({ scale: COVER_WIDTH / viewport.width });
    const canvas = createCanvas(COVER_WIDTH, Math.round(scaled.height));
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport: scaled, recordImages: true }).promise;
    const text = await page.getTextContent();
    const words = text.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .split(/\s+/)
      .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const { ink, colour, board } = measure(data, canvas.width, canvas.height);
    const look: PageLook = { aspect, ink, colour, image: largestImage(page.imageCoordinates as ArrayLike<number> | null), words };
    if (!isCover(look)) return null;
    if (!board) return encode(canvas);
    const boardWidth = board.right - board.left;
    const boardHeight = board.bottom - board.top;
    const cut = createCanvas(COVER_WIDTH, Math.round(COVER_WIDTH * boardHeight / boardWidth));
    cut.getContext("2d").drawImage(canvas, board.left, board.top, boardWidth, boardHeight, 0, 0, cut.width, cut.height);
    return encode(cut);
  } finally {
    await task.destroy();
  }
}

/**
 * Page 1 of the PDF as the book's cover, or null when it is not one (a title page, a page of text, a slide) or cannot be
 * drawn. Never rejects. Gives up after `timeoutMs`.
 */
export function renderCover(pdfPath: string, timeoutMs = TIMEOUT_MS): Promise<CoverImage | null> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { deepreadCover: pdfPath } });
    } catch (error) {
      console.warn(`no cover for ${pdfPath}: could not start the worker`, error);
      resolve(null);
      return;
    }
    const done = (cover: CoverImage | null, problem?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      if (problem) console.warn(`no cover for ${pdfPath}: ${problem}`);
      resolve(cover);
    };
    const timer = setTimeout(() => done(null, `drawing it took over ${timeoutMs} ms`), timeoutMs);
    worker.once("message", (message: { cover: CoverImage | null; problem?: string }) => done(message.cover, message.problem));
    worker.once("error", (error) => done(null, error.message));
    worker.once("exit", (code) => done(null, `the worker exited (code ${code})`));
  });
}

if (!isMainThread && typeof workerData?.deepreadCover === "string") {
  drawCover(workerData.deepreadCover).then(
    (cover) => parentPort?.postMessage({ cover }),
    (error: unknown) => parentPort?.postMessage({ cover: null, problem: error instanceof Error ? error.message : String(error) }),
  );
}
