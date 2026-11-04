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

/**
 * Resized figures, kept by name and width. A figure's name is the hash of its bytes (book-figures.ts), so a name names
 * exactly one image wherever it is stored, and taking one kept here needs no read or hash of the original. The cache is
 * shared by every library: a caller authorizes the figure in the reader's own book on every request before taking one.
 */
export type FigureVariants = {
  /** The figure named `name` at `width`, when it was resized before and is still kept. */
  kept(name: string, width: FigureWidth): Bytes | null;
  /** `data`, the figure named `name`, at `width`; `data` itself when it is not resized (see resizeFigure and the limits). */
  make(name: string, data: Bytes, width: FigureWidth): Promise<Bytes>;
};

export function createFigureVariants(options: {
  resize?: ResizeFigure;
  maxCacheBytes?: number;
  maxInFlightBytes?: number;
  maxConcurrent?: number;
  maxQueued?: number;
} = {}): FigureVariants {
  const resize = options.resize ?? resizeFigure;
  const maxCacheBytes = options.maxCacheBytes ?? 8 * 1024 * 1024;
  const maxInFlightBytes = options.maxInFlightBytes ?? 16 * 1024 * 1024;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const maxQueued = options.maxQueued ?? 16;
  const cache = new Map<string, Bytes>();
  const pending = new Map<string, Promise<Bytes>>();
  const queue: Array<() => void> = [];
  let cacheBytes = 0, inFlightBytes = 0, active = 0;
  const keyOf = (name: string, width: FigureWidth): string => `${name}/${width}`;
  const kept = (name: string, width: FigureWidth): Bytes | null => {
    const key = keyOf(name, width);
    const cached = cache.get(key);
    if (!cached) return null;
    // The one used last goes last, so the oldest is the one left longest unused.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  };
  return {
    kept,
    async make(name, data, width) {
      const key = keyOf(name, width);
      const cached = kept(name, width);
      if (cached) return cached;
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
    },
  };
}
