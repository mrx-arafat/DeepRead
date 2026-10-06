import { describe, expect, it } from "vitest";
import { WRONG_CODE_LINES, wrongCodeLine } from "./wrongCode.ts";

describe("wrongCodeLine", () => {
  it("should give a different line each time it is asked, so a second wrong code is not met with the same joke", () => {
    for (const previous of WRONG_CODE_LINES) {
      for (const roll of [0, 0.3, 0.7, 0.999]) {
        expect(wrongCodeLine(previous, () => roll)).not.toBe(previous);
      }
    }
  });

  it("should pick from the whole list", () => {
    const seen = new Set(Array.from({ length: 100 }, (_, n) => wrongCodeLine(null, () => n / 100)));
    expect(seen.size).toBe(WRONG_CODE_LINES.length);
  });

  it("should keep every line short, plain text, so it fits in two lines under the code box on a phone", () => {
    for (const line of WRONG_CODE_LINES) {
      expect(line.length).toBeLessThanOrEqual(70);
      expect(line).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
