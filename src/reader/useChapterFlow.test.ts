import { describe, expect, it } from "vitest";
import type { Chapter } from "../../shared/types.ts";
import { trimKnown } from "./useChapterFlow.ts";

const chapters = (...ids: string[]): Chapter[] => ids.map((id) => ({ id, title: id, startPage: 1, endPage: 1, blocks: [] }));
const ids = (list: Chapter[]): string[] => list.map((chapter) => chapter.id);

describe("trimKnown", () => {
  it("should drop chapters from the far end down to the cap and keep the list contiguous", () => {
    const list = chapters("c1", "c2", "c3", "c4", "c5", "c6", "c7");
    expect(ids(trimKnown(list, 5, new Set(), "start"))).toEqual(["c3", "c4", "c5", "c6", "c7"]);
    expect(ids(trimKnown(list, 5, new Set(), "end"))).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    // Within the cap, the same list comes back: no state change for the flow to commit.
    expect(trimKnown(list, 7, new Set(), "start")).toBe(list);
    expect(trimKnown(list, Infinity, new Set(), "end")).toBe(list);
  });

  it("should stop at a kept chapter rather than cut a hole in the flow", () => {
    const list = chapters("c1", "c2", "c3", "c4", "c5", "c6");
    // c2 holds the sentence being read aloud: c1 goes, c2 stays, and so does everything after it.
    expect(ids(trimKnown(list, 3, new Set(["c2"]), "start"))).toEqual(["c2", "c3", "c4", "c5", "c6"]);
    expect(ids(trimKnown(list, 3, new Set(["c5"]), "end"))).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(trimKnown(list, 3, new Set(["c1"]), "start")).toBe(list);
  });
});
