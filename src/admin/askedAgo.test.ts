import { describe, expect, it } from "vitest";
import { askedAgo } from "./askedAgo.ts";

const now = Date.UTC(2026, 9, 7, 12, 0, 0);
const before = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("askedAgo", () => {
  it("should say how long ago in the unit a person would, from just now to yesterday", () => {
    expect(askedAgo(before(20_000), now)).toBe("just now");
    expect(askedAgo(before(5 * MIN), now)).toBe("5 min ago");
    expect(askedAgo(before(59 * MIN), now)).toBe("59 min ago");
    expect(askedAgo(before(3 * HOUR), now)).toBe("3 h ago");
    expect(askedAgo(before(26 * HOUR), now)).toBe("yesterday");
    expect(askedAgo(before(4 * 24 * HOUR), now)).toBe("4 days ago");
  });

  it("should give the date once it is more than a week old, and never a time in the future", () => {
    expect(askedAgo(before(20 * 24 * HOUR), now)).toMatch(/Sep|17/);
    expect(askedAgo(new Date(now + 5 * MIN).toISOString(), now)).toBe("just now");
  });
});
