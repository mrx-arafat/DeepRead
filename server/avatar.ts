// A profile's photo: a PNG, JPEG or WebP the admin uploads, kept as a small square so the profile picker shows it at once.
import { encodePicture } from "./cover.ts";
import type { CoverImage } from "./cover.ts";

/** The square kept for a profile: WebP, or JPEG where this computer cannot write WebP. */
export type Photo = CoverImage;

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const SIDE = 256;
// About 256 MB once decoded. A small file can claim far more pixels than that, and the size is known before any pixel
// is decoded, so such a file is refused without decoding it.
const MAX_PIXELS = 64_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (data: Uint8Array, bytes: number[], at = 0): boolean => bytes.every((byte, i) => data[at + i] === byte);

/** Whether the file starts like a PNG, a JPEG or a WebP. The name and declared type of an upload prove nothing. */
export function isPhotoFile(head: Uint8Array): boolean {
  return (
    startsWith(head, PNG_SIGNATURE) ||
    startsWith(head, [0xff, 0xd8, 0xff]) ||
    // "RIFF", four bytes of length, "WEBP".
    (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8))
  );
}

type Size = { width: number; height: number };

/** The first JPEG frame header (SOF0 to SOF15, but not C4, C8 and CC, which are tables) holds the size. */
function jpegSize(view: DataView): Size | null {
  let at = 2;
  for (;;) {
    if (view.getUint8(at) !== 0xff) return null;
    const marker = view.getUint8(at + 1);
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers that stand alone, with no length after them.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // The end of the file, or the start of the picture data, with no frame header before it.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // Length (2 bytes), sample precision (1), then height and width.
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    const length = view.getUint16(at + 2);
    // The length counts its own 2 bytes; less would never move on.
    if (length < 2) return null;
    at += 2 + length;
  }
}

/** The size a WebP's first chunk gives: lossy (VP8), lossless (VP8L) or extended (VP8X, the canvas size). */
function webpSize(view: DataView, chunk: string): Size | null {
  if (chunk === "VP8 ") {
    // A key frame: 3 bytes of frame tag, the start code 9D 01 2A, then 14 bits each of width and height.
    if (view.getUint8(23) !== 0x9d || view.getUint8(24) !== 0x01 || view.getUint8(25) !== 0x2a) return null;
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // The signature byte 2F, then 14 bits each of width - 1 and height - 1.
    if (view.getUint8(20) !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // Flags and 3 reserved bytes, then 24 bits each of width - 1 and height - 1.
    const uint24 = (at: number): number => view.getUint16(at, true) | (view.getUint8(at + 2) << 16);
    return { width: uint24(24) + 1, height: uint24(27) + 1 };
  }
  return null;
}

/** The size a PNG, JPEG or WebP says it has, read from its header without decoding a pixel; null when it cannot be read. */
function headerSize(data: Uint8Array): Size | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = (at: number, length: number): string => String.fromCharCode(...data.subarray(at, at + length));
  try {
    if (startsWith(data, PNG_SIGNATURE)) {
      // The IHDR chunk always comes first: its length and name, then width and height.
      return text(12, 4) === "IHDR" ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
    }
    if (startsWith(data, [0xff, 0xd8])) return jpegSize(view);
    if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP") return webpSize(view, text(12, 4));
    return null;
  } catch (error) {
    // A header cut short: the size would be past the end of the file.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * The centre square of the photo, 256 pixels a side, turned the way the camera recorded it.
 * "unreadable" when it is not a picture after all, "too_large" when it has too many pixels to decode safely.
 */
export async function squarePhoto(data: Uint8Array): Promise<Photo | "unreadable" | "too_large"> {
  // Decoding makes room for every pixel the file claims, so the claim is checked first, from the header alone.
  const claimed = headerSize(data);
  if (!claimed || !(claimed.width >= 1 && claimed.height >= 1)) return "unreadable";
  if (claimed.width * claimed.height > MAX_PIXELS) return "too_large";
  // Loaded on first use, so a DeepRead that never sees a photo never loads the image library here.
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  let image;
  try {
    image = await loadImage(data);
  } catch {
    return "unreadable";
  }
  const { width, height } = image;
  if (!(width >= 1 && height >= 1)) return "unreadable";
  // Checked again on what was decoded, in case a file's insides disagree with its header.
  if (width * height > MAX_PIXELS) return "too_large";
  const side = Math.min(width, height);
  const canvas = createCanvas(SIDE, SIDE);
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, SIDE, SIDE);
  return encodePicture(canvas);
}
