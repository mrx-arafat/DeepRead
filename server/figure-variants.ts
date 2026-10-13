import { createHash } from "node:crypto";

export const FIGURE_WIDTHS = [480, 960, 1440] as const;
export type FigureWidth = typeof FIGURE_WIDTHS[number];

export function figureWidth(value: string): FigureWidth | null {
  return FIGURE_WIDTHS.find((width) => String(width) === value) ?? null;
}

type Bytes = Uint8Array<ArrayBuffer>;
type ResizeFigure = (data: Bytes, width: FigureWidth) => Promise<Bytes>;

/** Check dimensions before decoding, so malformed stored images cannot allocate unbounded pixels. */
async function resizeFigure(data: Bytes, width: FigureWidth): Promise<Bytes> {
  const png = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString("ascii", 12, 16) !== "IHDR") return data;
  const sourceWidth = png.readUInt32BE(16), sourceHeight = png.readUInt32BE(20);
  if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > 4_000_000 || sourceWidth > 10_000 || sourceHeight > 10_000 || sourceWidth <= width) return data;
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(png);
  const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
  const canvas = createCanvas(width, height);
  // PNG and a transparent canvas preserve diagrams' alpha rather than adding a background.
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  return new Uint8Array(await canvas.encode("png"));
}

/** Derived bytes are cached by content, but callers must authorize/read the original on every request. */
export function createFigureVariants(options: {
  resize?: ResizeFigure;
  maxCacheBytes?: number;
  maxInFlightBytes?: number;
  maxConcurrent?: number;
  maxQueued?: number;
} = {}): (data: Bytes, width: FigureWidth) => Promise<Bytes> {
  const resize = options.resize ?? resizeFigure;
  const maxCacheBytes = options.maxCacheBytes ?? 8 * 1024 * 1024;
  const maxInFlightBytes = options.maxInFlightBytes ?? 16 * 1024 * 1024;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const maxQueued = options.maxQueued ?? 16;
  const cache = new Map<string, Bytes>();
  const pending = new Map<string, Promise<Bytes>>();
  const queue: Array<() => void> = [];
  let cacheBytes = 0, inFlightBytes = 0, active = 0;
  return async (data, width) => {
    const key = `${createHash("sha256").update(data).digest("hex")}/${width}`;
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    const known = pending.get(key);
    if (known) return known;
    // Ordinary browser bursts wait for a resize slot. Bound both the queue and input bytes
    // held by active/queued jobs; only overflow falls back to the original image.
    if (maxConcurrent <= 0 || (active >= maxConcurrent && queue.length >= maxQueued) || data.byteLength + inFlightBytes > maxInFlightBytes) return data;
    inFlightBytes += data.byteLength;
    let resolve!: (result: Bytes) => void;
    const run = new Promise<Bytes>((ready) => { resolve = ready; });
    pending.set(key, run);
    const start = () => {
      active++;
      void Promise.resolve().then(() => resize(data, width)).then((result) => {
        if (result !== data && result.byteLength <= maxCacheBytes) {
          while ((cacheBytes + result.byteLength > maxCacheBytes || cache.size >= 64) && cache.size) {
            const oldest = cache.keys().next().value!;
            cacheBytes -= cache.get(oldest)!.byteLength;
            cache.delete(oldest);
          }
          cache.set(key, result);
          cacheBytes += result.byteLength;
        }
        return result;
      }).catch(() => data).finally(() => {
        pending.delete(key);
        inFlightBytes -= data.byteLength;
        active--;
        queue.shift()?.();
      }).then(resolve);
    };
    if (active < maxConcurrent) start();
    else queue.push(start);
    return run;
  };
}
