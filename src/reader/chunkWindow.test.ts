import { describe, expect, it } from "vitest";
import type { Block } from "../../shared/types.ts";
import { calibrate, ChunkHeights, chunkKeys, chunksOf, defaultCalibration, estimateHeight, initialMounted, sameSet, windowOf } from "./chunkWindow.ts";

const paragraphs = (count: number, prefix = "b"): Block[] =>
  Array.from({ length: count }, (_, at) => ({ id: `${prefix}${at}`, type: "paragraph", page: 1, text: `Paragraph ${at} `.repeat(8) }));
const figure: Block = { id: "fig", type: "image", page: 1, text: "", image: { src: `figures/${"a".repeat(64)}.png`, width: 2000, height: 1500, alt: "" } };
const set = (...items: string[]) => new Set(items);

describe("chunksOf", () => {
  it("groups rows by the tier's chunk size and keeps a figure alone", () => {
    const chunks = chunksOf([...paragraphs(50), figure, ...paragraphs(3, "c")], 24);
    expect(chunks.map((chunk) => [chunk.key, chunk.blocks.length, chunk.start])).toEqual([["b0", 24, 0], ["b24", 24, 24], ["b48", 2, 48], ["fig", 1, 50], ["c0", 3, 51]]);
    expect(chunkKeys(chunks).get("b30")).toBe("b24");
  });
});

describe("windowOf", () => {
  const chunks = chunksOf(paragraphs(120), 24);

  it("mounts near or pinned chunks, keeps a mounted chunk inside the keep margin, and drops the rest", () => {
    const next = windowOf(chunks, { mounted: set("b0", "b24", "b96"), near: set("b48"), kept: set("b24", "b48", "b72"), pinned: set("b96") });
    expect([...next]).toEqual(["b24", "b48", "b96"]);
  });

  it("never mounts a chunk that is only inside the keep margin", () => {
    expect([...windowOf(chunks, { mounted: set(), near: set(), kept: set("b48"), pinned: set() })]).toEqual([]);
  });

  it("compares sets by members", () => {
    expect(sameSet(set("a", "b"), set("b", "a"))).toBe(true);
    expect(sameSet(set("a"), set("a", "b"))).toBe(false);
  });

  it("opens with the first chunks and the chunks around the saved place", () => {
    expect([...initialMounted(chunks, 2, "b70")]).toEqual(["b0", "b24", "b48", "b72"]);
    expect([...initialMounted(chunks, 3)]).toEqual(["b0", "b24", "b48"]);
    expect([...initialMounted(chunks, 1, "missing")]).toEqual(["b0"]);
    expect([...initialMounted(chunks, 0, "b0")]).toEqual(["b0", "b24"]);
  });

  it("estimates placeholder heights from calibrated text and figure sizes", () => {
    const fallback = defaultCalibration(19, 30, 360);
    const calibrated = calibrate([{ chars: 4000, blocks: 24, height: 4000 * 0.5 + 24 * fallback.pxPerBlock }], fallback);
    expect(calibrated.pxPerChar).toBeCloseTo(0.5, 5);
    expect(calibrate([{ chars: 50, blocks: 1, height: 100 }], fallback)).toEqual(fallback);
    const text = paragraphs(2);
    expect(estimateHeight(text, calibrated, 360)).toBe(Math.round(text[0]!.text.length * 2 * 0.5 + 2 * fallback.pxPerBlock));
    expect(estimateHeight([figure], calibrated, 360)).toBe(Math.round(360 * 0.75 + 48));
  });

  it("remembers a measured height only for the epoch it was measured in, and forgets the oldest past its bound", () => {
    const heights = new ChunkHeights(2);
    heights.remember("c1:b0", "e1", 500);
    expect(heights.get("c1:b0", "e1")).toBe(500);
    expect(heights.get("c1:b0", "e2")).toBeUndefined();
    heights.remember("c1:b24", "e1", 600);
    heights.remember("c1:b48", "e1", 700);
    expect(heights.get("c1:b0", "e1")).toBeUndefined();
    expect(heights.size).toBe(2);
  });
});
