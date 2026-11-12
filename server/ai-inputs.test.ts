// How much of the book a model call is shown around the paragraph the reader is on.
import { describe, expect, it } from "vitest";
import type { Block } from "../shared/types.ts";
import { buildPassage } from "./ai-inputs.ts";

const blocks = (lengths: number[]): Block[] =>
  lengths.map((length, at) => ({ id: `c1-b${at}`, type: "paragraph", text: `p${at} ${"x".repeat(length)}`, page: 1 }));

describe("buildPassage", () => {
  it("should show a line being translated the 20 paragraphs before it, so the speaker can be told, and an explanation 6", () => {
    const book = blocks(Array.from({ length: 30 }, () => 10));
    const reader = (task: "explain" | "translate") => buildPassage(book, 25, task).split("[The reader is on this paragraph]")[0];
    expect(reader("translate")).toContain("p5 ");
    expect(reader("translate")).not.toContain("p4 ");
    expect(reader("explain")).toContain("p19 ");
    expect(reader("explain")).not.toContain("p18 ");
  });

  it("should stop going back at 8,000 characters but always keep the paragraph just before", () => {
    const book = blocks([100, 5_000, 5_000, 100, 100]);
    const before = buildPassage(book, 4, "translate").split("[The reader is on this paragraph]")[0];
    // 100 + 5,000 fit; the next 5,000 would pass the limit.
    expect(before).toContain("p3 ");
    expect(before).toContain("p2 ");
    expect(before).not.toContain("p1 ");
    expect(buildPassage(blocks([9_000, 10]), 1, "translate")).toContain("p0 ");
  });
});
