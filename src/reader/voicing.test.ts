import { describe, expect, it } from "vitest";
import { forSpeech, pauseBetween, pickVoice } from "./voicing.ts";

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
  const at = (blockId: string, kind: "text" | "heading" | "title" = "text", length = 30) => ({ blockId, kind, length });

  it("should leave a breath after a sentence, longer when the sentences are long", () => {
    expect(pauseBetween(at("b1"), at("b1"), 1)).toBe(300);
    expect(pauseBetween(at("b1", "text", 120), at("b1"), 1)).toBe(450);
    expect(pauseBetween(at("b1"), at("b1", "text", 120), 1)).toBe(450);
  });

  it("should leave a longer silence at a new paragraph, and the longest around headings and chapter titles", () => {
    expect(pauseBetween(at("b1"), at("b2"), 1)).toBe(1000);
    expect(pauseBetween(at("b2"), at("h1", "heading"), 1)).toBe(1800);
    expect(pauseBetween(at("h1", "heading"), at("b3"), 1)).toBe(1800);
    expect(pauseBetween(at("t1", "title"), at("b1"), 1)).toBe(2500);
  });

  it("should shorten the silences when the reader speeds the voice up, and lengthen them when slowed down", () => {
    expect(pauseBetween(at("b1"), at("b2"), 1.5)).toBe(667);
    expect(pauseBetween(at("b1"), at("b1"), 0.6)).toBe(500);
  });
});

describe("pickVoice", () => {
  const voice = (name: string, lang = "en-US", localService = true) => ({ name, lang, localService });

  it("should choose the most natural voice that runs on the computer", () => {
    const voices = [voice("Albert"), voice("Bad News"), voice("Daniel", "en-GB"), voice("Karen", "en-AU"), voice("Samantha")];
    expect(pickVoice(voices)?.name).toBe("Samantha");
    expect(pickVoice([voice("Samantha"), voice("Ava (Premium)")])?.name).toBe("Ava (Premium)");
  });

  it("should never pick a novelty or robot voice while an ordinary one exists", () => {
    const voices = [voice("Albert"), voice("Bubbles"), voice("Fred"), voice("Whisper"), voice("Moira", "en-IE")];
    expect(pickVoice(voices)?.name).toBe("Moira");
  });

  it("should prefer a voice that runs on the computer over a network one, which cuts long sentences short and reports no words", () => {
    const voices = [voice("Google US English", "en-US", false), voice("Microsoft David - English (United States)")];
    expect(pickVoice(voices)?.name).toBe("Microsoft David - English (United States)");
  });

  it("should ignore voices in other languages, and say so when there is no English voice", () => {
    expect(pickVoice([voice("Amelie", "fr-CA"), voice("Samantha")])?.name).toBe("Samantha");
    expect(pickVoice([voice("Amelie", "fr-CA")])).toBeNull();
  });
});
