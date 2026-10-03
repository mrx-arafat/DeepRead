import { describe, expect, it } from "vitest";
import { placeIn } from "./useReadingPosition.ts";

describe("placeIn", () => {
  it("should read the place kept with a page of history, alongside whatever else is there", () => {
    expect(placeIn({ other: 1, place: { chapterId: "c7", blockId: "c7-b6", offset: 569 } })).toEqual({
      chapterId: "c7",
      blockId: "c7-b6",
      offset: 569,
    });
  });

  it("should ignore a page of history with no place, or one written by something else", () => {
    expect(placeIn(null)).toBeNull();
    expect(placeIn("c7")).toBeNull();
    expect(placeIn({ place: "c7-b6" })).toBeNull();
    expect(placeIn({ place: { chapterId: "c7", blockId: "c7-b6" } })).toBeNull();
    expect(placeIn({ place: { chapterId: "c7", blockId: 6, offset: 0 } })).toBeNull();
  });
});
