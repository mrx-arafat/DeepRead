import { describe, expect, it } from "vitest";
import { bookCountText, codeProblemFor, deleteQuestion, photoProblem } from "./profileText.ts";

describe("bookCountText", () => {
  it("should name none, one and many books", () => {
    expect([0, 1, 3].map(bookCountText)).toEqual(["No books", "1 book", "3 books"]);
  });
});

describe("deleteQuestion", () => {
  it("should say what the profile's books take with it", () => {
    expect(deleteQuestion("Sam", 3)).toBe("Delete Sam? Their 3 books, notes and saved answers are removed for good.");
    expect(deleteQuestion("Sam", 0)).toBe("Delete Sam? They have no books, so only the profile goes.");
  });
});

describe("photoProblem", () => {
  it("should accept a PNG, JPEG or WebP of up to 5 MB", () => {
    expect(photoProblem({ type: "image/webp", size: 5_000_000 })).toBeNull();
  });

  it("should explain a photo that is too big or not an accepted picture", () => {
    expect(photoProblem({ type: "image/png", size: 6_200_000 })).toBe(
      "That photo is 6.2 MB. Photos can be up to 5 MB, so choose a smaller one.",
    );
    expect(photoProblem({ type: "image/gif", size: 10 })).toBe("Choose a PNG, JPEG or WebP photo.");
  });
});

describe("codeProblemFor", () => {
  it("should accept a code of 6 to 64 characters", () => {
    expect([codeProblemFor("sixsix", true), codeProblemFor("x".repeat(64), true)]).toEqual([null, null]);
  });

  it("should say 6 to 64 characters when a code is too short or too long", () => {
    expect(codeProblemFor("fives", true)).toBe("Choose a code of 6 to 64 characters.");
    expect(codeProblemFor("x".repeat(65), true)).toBe("Choose a code of 6 to 64 characters.");
    expect(codeProblemFor("fives", false)).toBe("A new code needs 6 to 64 characters. Leave it empty to keep the current one.");
  });
});
