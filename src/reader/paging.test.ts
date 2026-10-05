import { describe, expect, it } from "vitest";
import { mergeLines, pageEnd, pagesLeft, previousPageTop, snapShift } from "./paging.ts";

/** Lines 20px tall every 30px from `first`, as text set with some leading would give. */
const linesFrom = (first: number, count: number) =>
  Array.from({ length: count }, (_, at) => ({ top: first + at * 30, bottom: first + at * 30 + 20 }));

describe("mergeLines", () => {
  it("should make one line of the pieces of text that share it, top to bottom", () => {
    const pieces = [
      { top: 140, bottom: 160 },
      { top: 100, bottom: 120 },
      { top: 141, bottom: 162 },
      { top: 101, bottom: 121 },
    ];
    expect(mergeLines(pieces)).toEqual([
      { top: 100, bottom: 121 },
      { top: 140, bottom: 162 },
    ]);
  });
});

describe("pageEnd", () => {
  const lines = linesFrom(40, 6);

  it("should end the page at the first line that does not fit whole", () => {
    // 160-180 crosses the page bottom at 175.
    expect(pageEnd(lines, 40, 175)).toBe(160);
  });

  it("should end the page where the next chapter starts, so each chapter opens on a page of its own", () => {
    expect(pageEnd(lines, 40, 175, [100])).toBe(100);
    // A chapter starting this very page does not end it.
    expect(pageEnd(lines, 40, 175, [40])).toBe(160);
  });

  it("should end at the page bottom when every line fits, or when one line is taller than the page", () => {
    expect(pageEnd(lines, 40, 400)).toBe(400);
    expect(pageEnd([{ top: 40, bottom: 900 }], 40, 175)).toBe(175);
  });
});

describe("snapShift", () => {
  it("should move a line cut by the top of the page down to start there", () => {
    expect(snapShift(linesFrom(25, 3), 40)).toBe(-15);
  });

  it("should leave a page that starts on a line as it is", () => {
    expect(snapShift(linesFrom(40, 3), 40)).toBe(0);
  });
});

describe("previousPageTop", () => {
  // Document coordinates: lines every 30px from the top of the book.
  const lines = linesFrom(0, 20);

  it("should start the page before on the first whole line that fits above the current one", () => {
    // The page is 135px tall (40 to 175 in the window), so the page before starts at or after 300 - 135.
    expect(previousPageTop(lines, 300, 40, 175)).toBe(180);
  });

  it("should end that page where the current one starts, so turning on again comes back to it", () => {
    const top = previousPageTop(lines, 300, 40, 175);
    const scroll = top - 40;
    const inWindow = lines.map((line) => ({ top: line.top - scroll, bottom: line.bottom - scroll }));
    expect(pageEnd(inWindow, 40, 175) + scroll).toBe(300);
  });

  it("should start the page before at a chapter start between the two, as no page runs across one", () => {
    expect(previousPageTop(lines, 300, 40, 175, [200])).toBe(200);
    // Above that chapter's first line, in the space over its title: the page still starts at the chapter's top.
    expect(previousPageTop(lines, 300, 40, 175, [170])).toBe(170);
    // A chapter starting further back than a page away is another page's business.
    expect(previousPageTop(lines, 300, 40, 175, [100])).toBe(180);
  });

  it("should go no further back than the start of the book", () => {
    expect(previousPageTop(lines, 60, 40, 175)).toBe(0);
  });
});

describe("pagesLeft", () => {
  it("should count the pages after this one up to the chapter's last line", () => {
    // 700px of chapter after this page's end, 135px a page.
    expect(pagesLeft(1000, 300, 40, 175)).toBe(6);
  });

  it("should say none are left on the chapter's last page", () => {
    expect(pagesLeft(280, 300, 40, 175)).toBe(0);
  });
});
