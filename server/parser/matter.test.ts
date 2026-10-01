import { describe, expect, it } from "vitest";
import { separateMatter, type MatterSection } from "./matter.mjs";

const prose = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ") + ".";
const section = (title: string, texts: string[], extra: Partial<MatterSection> = {}): MatterSection => ({
  title,
  startPage: 1,
  y: null,
  blocks: texts.map((text) => ({ text, page: 1, y: 0 })),
  ...extra,
});
const shape = (sections: MatterSection[]) => sections.map((s) => [s.title, s.kind, s.blocks.length]);

describe("separateMatter", () => {
  it("should open past the title page and contents and end before the notes and index when they surround the chapters", () => {
    const sections = separateMatter([
      section("Front Matter", ["A Book", "By Someone"], { untitled: true }),
      section("Contents", ["Chapter 1", "Epilogue", "Notes"]),
      section("Chapter 1", [prose(80), prose(90)]),
      section("Epilogue", [prose(60)]),
      section("NOTES", ["1. A source."]),
      section("Index", ["apple, 3", "pear, 4"]),
    ]);
    expect(shape(sections)).toEqual([
      ["Front Matter", "front", 5],
      ["Chapter 1", "body", 2],
      ["Epilogue", "body", 1],
      ["NOTES", "back", 1],
      ["Index", "back", 2],
    ]);
  });

  it("should cut Project Gutenberg's header and licence off the book when they fall inside chapters", () => {
    const sections = separateMatter([
      section("Chapter 1", ["This eBook is for the use of anyone.", "*** START OF THE PROJECT GUTENBERG EBOOK A BOOK ***", prose(80)]),
      section("Chapter 2", [prose(70), "*** END OF THE PROJECT GUTENBERG EBOOK A BOOK ***", "Updated editions will replace the previous one."]),
    ]);
    expect(shape(sections)).toEqual([
      ["Front Matter", "front", 2],
      ["Chapter 1", "body", 1],
      ["Chapter 2", "body", 1],
      ["Project Gutenberg License", "back", 2],
    ]);
  });

  it("should keep a long untitled opening as reading text when it reads like a chapter", () => {
    const sections = separateMatter([
      section("Front Matter", Array.from({ length: 20 }, () => prose(70)), { untitled: true }),
      section("Chapter 2", [prose(80)]),
    ]);
    expect(shape(sections)).toEqual([
      ["Front Matter", "body", 20],
      ["Chapter 2", "body", 1],
    ]);
  });
});
