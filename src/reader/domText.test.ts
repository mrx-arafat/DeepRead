import { afterEach, describe, expect, it, vi } from "vitest";
import { blockText, offsetInBlock, rangeWithin, textPosition } from "./domText.ts";
import { rangeInBlock, wordRangeAtPoint } from "./textRanges.ts";

describe("logical offsets through inline styles", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture() {
    class TextNode {
      data: string;
      parentElement: ElementNode | null = null;
      constructor(data: string) { this.data = data; }
      get textContent() { return this.data; }
    }
    class ElementNode {
      childNodes: Array<TextNode | ElementNode>;
      parentElement: ElementNode | null = null;
      readonly block: boolean;
      constructor(children: Array<TextNode | ElementNode>, block = false) {
        this.childNodes = children;
        this.block = block;
        for (const child of children) child.parentElement = this;
      }
      get textContent(): string { return this.childNodes.map((child) => child.textContent).join(""); }
      closest(): ElementNode | null { return this.block ? this : this.parentElement?.closest() ?? null; }
    }
    const first = new TextNode("inter");
    const styled = new TextNode("esting");
    const last = new TextNode(" words");
    const block = new ElementNode([first, new ElementNode([styled]), last], true);
    vi.stubGlobal("Text", TextNode);
    vi.stubGlobal("Element", ElementNode);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const ranges: Array<{ start?: [unknown, number]; end?: [unknown, number] }> = [];
    vi.stubGlobal("document", {
      querySelector: () => block,
      caretPositionFromPoint: () => ({ offsetNode: styled, offset: 2 }),
      createRange: () => {
        const range: { start?: [unknown, number]; end?: [unknown, number] } = {};
        ranges.push(range);
        return {
          setStart: (node: unknown, offset: number) => { range.start = [node, offset]; },
          setEnd: (node: unknown, offset: number) => { range.end = [node, offset]; },
          getClientRects: () => [{ left: 0, right: 100, top: 0, bottom: 30 }],
        };
      },
    });
    return { first, styled, last, block: block as unknown as HTMLElement, ranges };
  }

  it("maps global offsets to nested text nodes without changing the source text", () => {
    const { block, styled, last } = fixture();
    expect(blockText(block)).toBe("interesting words");
    expect(offsetInBlock(block, styled as unknown as Node, 2)).toBe(7);
    expect(textPosition(block, 7)).toEqual({ node: styled, offset: 2 });
    expect(textPosition(block, 17)).toEqual({ node: last, offset: 6 });
    expect(textPosition(block, 18)).toBeNull();
  });

  it("paints a source range across an inline boundary for highlights, search and speech", () => {
    const { block, first, styled, ranges } = fixture();
    expect(rangeWithin(block, 2, 10)).not.toBeNull();
    expect(ranges[0]).toEqual({ start: [first, 2], end: [styled, 5] });
    expect(rangeInBlock("block", { start: 2, end: 10 })).not.toBeNull();
    expect(ranges[1]).toEqual(ranges[0]);
    expect(rangeWithin(block, 0, 99)).toBeNull();
  });

  it("finds the complete word when its letters cross bold/italic nodes", () => {
    const { first, styled, ranges } = fixture();
    expect(wordRangeAtPoint(20, 10)).not.toBeNull();
    expect(ranges[0]).toEqual({ start: [first, 0], end: [styled, 6] });
  });
});
