import { describe, expect, it } from "vitest";
import { forSpeech, pauseBetween } from "./voicing.ts";

describe("forSpeech", () => {
  it("should turn a dash between words into a comma the voice pauses at, and find words again in the book's text", () => {
    const text = "the study of philosophy\u2014for philosophy is merely the attempt";
    const voiced = forSpeech(text);
    expect(voiced.text).toBe("the study of philosophy, for philosophy is merely the attempt");
    expect(voiced.original(voiced.text.indexOf("for philosophy"))).toBe(text.indexOf("for philosophy"));
    expect(voiced.original(voiced.text.indexOf("attempt"))).toBe(text.indexOf("attempt"));
  });

  it("should do the same for a spaced dash and a double hyphen", () => {
    expect(forSpeech("matter \u2014 something").text).toBe("matter, something");
    const text = "nothing real--or at any rate";
    const voiced = forSpeech(text);
    expect(voiced.text).toBe("nothing real, or at any rate");
    expect(voiced.original(voiced.text.indexOf("or at"))).toBe(text.indexOf("or at"));
  });

  it("should leave number ranges and ordinary text as they are", () => {
    const text = "Berkeley (1685\u20131753) and Leibniz (1646-1716) both admit it.";
    const voiced = forSpeech(text);
    expect(voiced.text).toBe(text);
    expect(voiced.original(20)).toBe(20);
  });
});

describe("pauseBetween", () => {
  const sentence = (blockId: string, title = false) => ({ blockId, title });

  it("should leave a short silence between sentences, a longer one at a new paragraph and the longest after a title", () => {
    expect(pauseBetween(sentence("b1"), sentence("b1"), 1)).toBe(350);
    expect(pauseBetween(sentence("b1"), sentence("b2"), 1)).toBe(750);
    expect(pauseBetween(sentence("t1", true), sentence("b1"), 1)).toBe(1000);
  });

  it("should shorten the silences when the reader speeds the voice up", () => {
    expect(pauseBetween(sentence("b1"), sentence("b2"), 1.5)).toBe(500);
    expect(pauseBetween(sentence("b1"), sentence("b1"), 0.8)).toBe(438);
  });
});
