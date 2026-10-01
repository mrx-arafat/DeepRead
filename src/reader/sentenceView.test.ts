import { describe, expect, it } from "vitest";
import { placeInView, scrollTopFor } from "./sentenceView.ts";

const WINDOW = 900;

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
