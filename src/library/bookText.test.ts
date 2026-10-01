import { describe, expect, it } from "vitest";
import { shortTitle } from "./bookText.ts";

describe("shortTitle", () => {
  it("should keep a title that fits as it is", () => {
    expect(shortTitle("The Problems of Philosophy", 60)).toBe("The Problems of Philosophy");
  });

  it("should cut a long title between words when it can, and say it was cut", () => {
    expect(shortTitle("A Complete Introduction to Knowledge", 25)).toBe("A Complete Introduction...");
    expect(shortTitle("abcde fghij", 5)).toBe("abcde...");
  });

  it("should cut inside a word when the title has no space to cut at", () => {
    expect(shortTitle("Supercalifragilistic", 5)).toBe("Super...");
  });

  it("should never cut inside a letter the reader sees as one when the title has joined characters", () => {
    const family = "👨‍👩‍👧";
    expect(shortTitle(`aaaaa${family}${family}${family}`, 6)).toBe(`aaaaa${family}...`);
  });
});
