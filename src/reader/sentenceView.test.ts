import { describe, expect, it } from "vitest";
import { clearSpan, placeInView, scrollTopFor } from "./sentenceView.ts";

const WINDOW = 900;
const VIEW = { top: 64, bottom: 836 };

describe("placeInView", () => {
  it("should say a sentence is above the window when it ended behind the top bar", () => {
    expect(placeInView({ top: -400, bottom: -360 }, WINDOW)).toBe("above");
  });

  it("should say a sentence is below the window when it starts under the player", () => {
    expect(placeInView({ top: 880, bottom: 940 }, WINDOW)).toBe("below");
  });

  it("should say a sentence is in view when part of it is on screen", () => {
    expect(placeInView({ top: -60, bottom: 120 }, WINDOW)).toBe("in");
  });
});

describe("scrollTopFor", () => {
  it("should not scroll when the sentence sits in the comfortable middle", () => {
    expect(scrollTopFor({ top: 300, bottom: 360 }, WINDOW, 1200)).toBeNull();
  });

  it("should put a sentence far below a third of the way down the window", () => {
    expect(scrollTopFor({ top: 1500, bottom: 1560 }, WINDOW, 1000)).toBe(1000 + 1500 - 270);
  });

  it("should scroll back up for a sentence above the window", () => {
    expect(scrollTopFor({ top: -2000, bottom: -1950 }, WINDOW, 2500)).toBe(2500 - 2000 - 270);
  });
});

describe("clearSpan", () => {
  it("should keep the sentence being read clear when the card fits above it", () => {
    expect(clearSpan({ top: 607, bottom: 636 }, [{ top: 543, bottom: 603 }], 260, VIEW)).toEqual({ top: 543, bottom: 636 });
  });

  it("should give up the less important sentence when both leave no room for the card", () => {
    const spoken = { top: 380, bottom: 440 };
    const own = { top: 200, bottom: 700 };
    expect(clearSpan({ top: 400, bottom: 430 }, [spoken, own], 300, VIEW)).toEqual({ top: 380, bottom: 440 });
  });

  it("should ignore a sentence that is out of view", () => {
    const gone = { top: -500, bottom: -440 };
    expect(clearSpan({ top: 300, bottom: 330 }, [gone, { top: 280, bottom: 350 }], 300, VIEW)).toEqual({ top: 280, bottom: 350 });
  });

  it("should cover only the word when the card fits on neither side of a long sentence", () => {
    expect(clearSpan({ top: 300, bottom: 330 }, [{ top: 80, bottom: 820 }], 300, VIEW)).toEqual({ top: 300, bottom: 330 });
  });
});
