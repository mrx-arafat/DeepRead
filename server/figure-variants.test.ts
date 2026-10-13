import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createFigureVariants, figureWidth } from "./figure-variants.ts";
import { booksRoutes } from "./routes-books.ts";
import type { AppEnv } from "./app-env.ts";
import type { ParsePdf, RenderCover } from "./deps.ts";

const bytes = (value: number, length = 4) => new Uint8Array(length).fill(value);

describe("responsive private figure variants", () => {
  it("downsamples real PNGs preserving aspect ratio and transparency, without upscaling", async () => {
    const original = new Uint8Array(await createCanvas(1200, 600).encode("png"));
    const variant = createFigureVariants();
    const small = await variant(original, 480);
    const image = await loadImage(small);
    expect([image.width, image.height]).toEqual([480, 240]);
    const canvas = createCanvas(480, 240);
    canvas.getContext("2d").drawImage(image, 0, 0);
    expect(canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3]).toBe(0);
    expect(await variant(original, 1440)).toBe(original);
    expect(await variant(original, 480)).toBe(small);
    expect(await variant(bytes(1), 480)).toEqual(bytes(1));
  });

  it("deduplicates work, bounds concurrency and retained bytes, and falls back on errors", async () => {
    let finish!: (result: Uint8Array<ArrayBuffer>) => void;
    const resize = vi.fn(() => new Promise<Uint8Array<ArrayBuffer>>((resolve) => { finish = resolve; }));
    const variant = createFigureVariants({ resize, maxConcurrent: 1, maxQueued: 0, maxInFlightBytes: 4, maxCacheBytes: 4 });
    const original = bytes(1), other = bytes(2);
    const first = variant(original, 480), duplicate = variant(original, 480);
    expect(await variant(other, 480)).toBe(other);
    await Promise.resolve();
    expect(resize).toHaveBeenCalledTimes(1);
    const result = bytes(3);
    finish(result);
    expect(await first).toBe(result);
    expect(await duplicate).toBe(result);
    const second = variant(other, 480);
    await Promise.resolve();
    finish(bytes(4));
    await second;
    const evicted = variant(original, 480);
    await Promise.resolve();
    expect(resize).toHaveBeenCalledTimes(3);
    finish(result);
    await evicted;
    expect(await variant(bytes(5, 5), 480)).toEqual(bytes(5, 5));
    const broken = createFigureVariants({ resize: async () => { throw new Error("decode failed"); } });
    expect(await broken(original, 480)).toBe(original);
  });

  it("waits for capacity during an ordinary three-figure burst and shares queued work", async () => {
    const jobs = new Map<number, (result: Uint8Array<ArrayBuffer>) => void>();
    const resize = vi.fn((data: Uint8Array<ArrayBuffer>) => new Promise<Uint8Array<ArrayBuffer>>((resolve) => jobs.set(data[0]!, resolve)));
    const variant = createFigureVariants({ resize });
    const first = variant(bytes(1), 480), second = variant(bytes(2), 480);
    const third = variant(bytes(3), 480), duplicate = variant(bytes(3), 480);
    let settled = false;
    void third.then(() => { settled = true; });
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    jobs.get(1)!(bytes(11));
    expect(await first).toEqual(bytes(11));
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(3));
    jobs.get(3)!(bytes(13));
    expect(await third).toEqual(bytes(13));
    expect(await duplicate).toEqual(bytes(13));
    jobs.get(2)!(bytes(12));
    expect(await second).toEqual(bytes(12));
  });

  it("bounds queued entries and the input bytes retained by active and queued jobs", async () => {
    for (const limits of [{ maxQueued: 1, maxInFlightBytes: 100 }, { maxQueued: 16, maxInFlightBytes: 8 }]) {
      const jobs = new Map<number, (result: Uint8Array<ArrayBuffer>) => void>();
      const resize = vi.fn((data: Uint8Array<ArrayBuffer>) => new Promise<Uint8Array<ArrayBuffer>>((resolve) => jobs.set(data[0]!, resolve)));
      const variant = createFigureVariants({ resize, maxConcurrent: 1, ...limits });
      const first = variant(bytes(1), 480), second = variant(bytes(2), 480);
      const overflow = bytes(3);
      expect(await variant(overflow, 480)).toBe(overflow);
      const duplicate = variant(bytes(2), 480);
      await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(1));
      jobs.get(1)!(bytes(11));
      expect(await first).toEqual(bytes(11));
      await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
      const resumed = variant(bytes(3), 480);
      jobs.get(2)!(bytes(12));
      expect(await second).toEqual(bytes(12));
      expect(await duplicate).toEqual(bytes(12));
      await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(3));
      jobs.get(3)!(bytes(13));
      expect(await resumed).toEqual(bytes(13));
    }
  });

  it("continues queued work after a failed resize and releases its input budget", async () => {
    let fail!: (error: Error) => void;
    const resize = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockImplementation(async () => bytes(9));
    const variant = createFigureVariants({ resize, maxConcurrent: 1, maxInFlightBytes: 8 });
    const original = bytes(1);
    const first = variant(original, 480), second = variant(bytes(2), 480);
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(1));
    fail(new Error("decode failed"));
    expect(await first).toBe(original);
    expect(await second).toEqual(bytes(9));
    expect(await variant(bytes(3, 8), 480)).toEqual(bytes(9));
    expect(resize).toHaveBeenCalledTimes(3);
  });

  it("strictly validates route widths and rereads authorized assets even after a cache hit", async () => {
    expect(["480", "960", "1440"].map(figureWidth)).toEqual([480, 960, 1440]);
    const original = new Uint8Array(await createCanvas(600, 300).encode("png"));
    const figure = vi.fn().mockResolvedValue(original);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("library", { figure } as unknown as AppEnv["Variables"]["library"]);
      await next();
    });
    app.route("/api/books", booksRoutes({ parsePdf: vi.fn() as unknown as ParsePdf, renderCover: vi.fn() as unknown as RenderCover }));
    const url = `/api/books/example-book/figures/${"a".repeat(64)}.png`;
    for (const query of ["width=481", "width=0480", "width=", "width=480&width=960", "width=-1"]) {
      expect((await app.request(`${url}?${query}`)).status).toBe(400);
    }
    expect(figure).not.toHaveBeenCalled();
    const response = await app.request(`${url}?width=480`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    const image = await loadImage(new Uint8Array(await response.arrayBuffer()));
    expect(image.width).toBe(480);
    figure.mockResolvedValue(null);
    expect((await app.request(`${url}?width=480`)).status).toBe(404);
    expect(figure).toHaveBeenCalledTimes(2);
  });
});
