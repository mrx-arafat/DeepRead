import { describe, expect, it } from "vitest";
import { APP_NAME, readerTitle } from "./pageTitle.ts";

describe("readerTitle", () => {
  it("should name the book and the chapter being read", () => {
    expect(readerTitle("The Problems of Philosophy", "CHAPTER II. THE EXISTENCE OF MATTER")).toBe(
      "The Problems of Philosophy - CHAPTER II. THE EXISTENCE OF MATTER",
    );
  });

  it("should name just the book while the chapter is unknown, and the app while the book is", () => {
    expect(readerTitle("The Problems of Philosophy", undefined)).toBe("The Problems of Philosophy");
    expect(readerTitle(undefined, undefined)).toBe(APP_NAME);
  });

  it("should not say the same name twice when the chapter is named after the book", () => {
    expect(readerTitle("Walden", "WALDEN")).toBe("Walden");
  });

  it("should cut a long book or chapter name short, between words", () => {
    const title = readerTitle(
      "An Extremely Long Book Title That Goes On And On Past The Width Of Any Tab",
      "CHAPTER XIV. AN EQUALLY LONG CHAPTER NAME THAT KEEPS GOING AND GOING",
    );
    expect(title).toBe("An Extremely Long Book Title That Goes... - CHAPTER XIV. AN EQUALLY LONG CHAPTER...");
  });
});
