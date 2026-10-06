import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { squarePhoto } from "./avatar.ts";

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const be = (value: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => (value >>> (8 * (bytes - 1 - i))) & 0xff);
const le = (value: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => (value >>> (8 * i)) & 0xff);

// Headers alone, with no pixels after them: decoding any of these fails, so only the header can call one too large.
const png = (width: number, height: number): number[] => [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be(13, 4), ...ascii("IHDR"), ...be(width, 4), ...be(height, 4), 8, 6, 0, 0, 0, ...be(0, 4),
];
const jpeg = (width: number, height: number): number[] => [
  0xff, 0xd8,
  0xff, 0xe0, ...be(16, 2), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  // A Huffman table (C4): its bytes would claim a 1 by 1 picture if it were taken for the frame header.
  0xff, 0xc4, ...be(7, 2), 8, ...be(1, 2), ...be(1, 2),
  0xff, 0xc0, ...be(17, 2), 8, ...be(height, 2), ...be(width, 2), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
];
const webp = (chunk: string, payload: number[]): number[] => [
  ...ascii("RIFF"), ...le(12 + payload.length, 4), ...ascii("WEBP"), ...ascii(chunk), ...le(payload.length, 4), ...payload,
];
const vp8 = (width: number, height: number): number[] => webp("VP8 ", [0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le(width, 2), ...le(height, 2)]);
const vp8l = (width: number, height: number): number[] => webp("VP8L", [0x2f, ...le((width - 1) | ((height - 1) << 14), 4)]);
const vp8x = (width: number, height: number): number[] => webp("VP8X", [0x10, 0, 0, 0, ...le(width - 1, 3), ...le(height - 1, 3)]);

// The 1 by 1 pictures browsers' WebP checks use: lossy (VP8), lossless (VP8L) and with transparency (VP8X).
const TINY_WEBPS = [
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
  "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
  "UklGRkoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAARBxAR/Q9ERP8DAABWUDggGAAAABQBAJ0BKgEAAQAAAP4AAA3AAP7mtQAAAA==",
];

describe("squarePhoto", () => {
  it("should refuse a picture claiming too many pixels from its header alone, and still read real ones", async () => {
    for (const header of [png, jpeg, vp8, vp8l, vp8x]) {
      // 64 million pixels may be decoded; one row more may not.
      expect([header.name, await squarePhoto(new Uint8Array(header(8001, 8000)))]).toEqual([header.name, "too_large"]);
      expect([header.name, await squarePhoto(new Uint8Array(header(8000, 8000)))]).toEqual([header.name, "unreadable"]);
    }
    // Cut short, or a JPEG segment that claims no length (which would never move on): unreadable, not looped over.
    expect(await squarePhoto(new Uint8Array(png(9000, 9000).slice(0, 20)))).toBe("unreadable");
    expect(await squarePhoto(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("unreadable");

    const canvas = createCanvas(300, 200);
    canvas.getContext("2d").fillRect(0, 0, 300, 200);
    const real = [await canvas.encode("png"), await canvas.encode("jpeg", 85), ...TINY_WEBPS.map((data) => Buffer.from(data, "base64"))];
    for (const data of real) {
      expect(await squarePhoto(new Uint8Array(data))).toEqual({ data: expect.any(Uint8Array), type: expect.stringMatching(/^image\/(webp|jpeg)$/) });
    }
  });
});
