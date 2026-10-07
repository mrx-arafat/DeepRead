import { describe, expect, it } from "vitest";
import type { Chapter, HighlightNote, ReadingProgress } from "../../shared/types.ts";
import { resumeText } from "./resumeText.ts";

const chapter: Chapter = {
  id: "c1", title: "One", startPage: 1, endPage: 2,
  blocks: [
    { id: "b1", type: "paragraph", text: "Earlier words.", page: 1 },
    { id: "b2", type: "paragraph", text: "echo then echo unread ending", page: 2 },
    { id: "b3", type: "paragraph", text: "Future words.", page: 2 },
  ],
};
const progress: ReadingProgress = { chapterId: "c1", chapterTitle: "One", blockId: "b2", offset: 14, percent: 30, updatedAt: "2026-10-07T00:00:00Z" };
const mark = (offset: number, quote = "echo"): HighlightNote => ({ id: `h${offset}`, chapterId: "c1", blockId: "b2", offset, quote, lang: "bn", mode: "highlight", color: "yellow" });

describe("resumeText", () => {
  it("should retain the exact source of the nearest preceding highlight for a reading detour", () => {
    expect(resumeText(chapter, progress, [mark(0), mark(10)]).highlight).toEqual({
      quote: "echo", page: 2, blockId: "b2", offset: 10,
    });
  });

  it("should include only preceding text and the nearest resolved highlight when quotations repeat", () => {
    expect(resumeText(chapter, progress, [mark(0), mark(10), mark(15, "unread")])).toEqual({
      state: "ready", excerpt: "Earlier words.\n\necho then echo", highlight: { quote: "echo", page: 2, blockId: "b2", offset: 10 },
    });
    expect(resumeText(chapter, { ...progress, offset: 12 }, [mark(10)]).highlight).toBeNull();
    expect(resumeText(chapter, progress, [mark(0, "echo then"), mark(10)]).highlight).toEqual({ quote: "echo", page: 2, blockId: "b2", offset: 10 });
  });

  it("should show no preceding passage at the first saved block start or without progress", () => {
    expect(resumeText(chapter, { ...progress, blockId: "b1", offset: 0 }, [])).toEqual({ state: "start", excerpt: "", highlight: null });
    expect(resumeText(chapter, null, [])).toEqual({ state: "start", excerpt: "", highlight: null });
  });

  it("should keep missing anchors and invalid offsets from revealing text", () => {
    for (const position of [{ ...progress, blockId: "gone" }, { ...progress, chapterId: "gone" }, { ...progress, offset: NaN }, { ...progress, offset: Infinity }]) {
      expect(resumeText(chapter, position, [mark(0)])).toEqual({ state: "missing", excerpt: "", highlight: null });
    }
  });

  it("should treat old absent offsets as the block start and clamp finite offsets to its text", () => {
    expect(resumeText(chapter, { ...progress, offset: undefined }, []).excerpt).toBe("Earlier words.");
    expect(resumeText(chapter, { ...progress, offset: -2 }, []).excerpt).toBe("Earlier words.");
    expect(resumeText(chapter, { ...progress, offset: 1000 }, []).excerpt).toBe("Earlier words.\n\necho then echo unread ending");
  });

  it("should ignore mismatched quotations, future blocks and highlights crossing the saved boundary", () => {
    const marks = [mark(1), mark(10, "echo unread"), { ...mark(0, "Future words."), blockId: "b3" }];
    expect(resumeText(chapter, progress, marks).highlight).toBeNull();
  });

  it("should bound the excerpt and highlight without including text from the next block", () => {
    const long: Chapter = { ...chapter, blocks: [{ ...chapter.blocks[0]!, text: "a ".repeat(500) }, chapter.blocks[1]!, chapter.blocks[2]!] };
    const result = resumeText(long, progress, []);
    expect(result.excerpt.length).toBeLessThanOrEqual(600);
    expect(result.excerpt.endsWith("echo then echo")).toBe(true);
    expect(result.excerpt).not.toContain("unread");
    expect(result.excerpt).not.toContain("Future");
  });

  it("should never split a visible character at the saved boundary", () => {
    const joined: Chapter = { ...chapter, blocks: [{ ...chapter.blocks[0]!, text: "A 👨‍👩‍👧 end" }] };
    expect(resumeText(joined, { ...progress, blockId: "b1", offset: 4 }, []).excerpt).toBe("A");
  });

  it("should bound a long resolved highlight and label the truncation", () => {
    const quote = "a".repeat(400);
    const long: Chapter = { ...chapter, blocks: [{ ...chapter.blocks[0]!, text: quote }] };
    const highlight = { ...mark(0, quote), blockId: "b1" };
    expect(resumeText(long, { ...progress, blockId: "b1", offset: 400 }, [highlight]).highlight).toEqual({ quote: `${"a".repeat(280)}...`, page: 1, blockId: "b1", offset: 0 });
  });

  it("should keep a bounded reminder when preceding text has no spaces", () => {
    const text = "a".repeat(1000);
    const long: Chapter = { ...chapter, blocks: [{ ...chapter.blocks[0]!, text }] };
    expect(resumeText(long, { ...progress, blockId: "b1", offset: 1000 }, [])).toEqual({
      state: "ready", excerpt: `...${"a".repeat(597)}`, highlight: null,
    });
  });
});
