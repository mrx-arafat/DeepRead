import { describe, expect, it } from "vitest";
import { chunksOf, fastEnough, trimSilence, wordTimes } from "./naturalTiming.ts";

describe("wordTimes", () => {
  it("should start each word where it begins in the text, the first at once and every one in order", () => {
    const text = "This question is difficult";
    const times = wordTimes(text, 2);
    expect(times.map((w) => text.slice(w.start, w.start + w.length))).toEqual(["This", "question", "is", "difficult"]);
    expect(times[0]?.at).toBe(0);
    expect(times.every((w, i) => i === 0 || w.at > (times[i - 1]?.at ?? 0))).toBe(true);
    expect(times.at(-1)?.at).toBeLessThan(2);
  });

  it("should give longer words more of the time, and hold the voice a little after a comma or a full stop", () => {
    const plain = wordTimes("alpha beta gamma delta", 4);
    const punctuated = wordTimes("alpha, beta. gamma delta", 4);
    // "beta" starts later after "alpha," than after "alpha"; "gamma" later after "beta." than after "beta".
    expect(punctuated[1]!.at).toBeGreaterThan(plain[1]!.at);
    expect(punctuated[2]!.at).toBeGreaterThan(plain[2]!.at);
    const longShort = wordTimes("a extraordinarily", 3);
    expect(longShort[1]!.at).toBeLessThan(1);
  });

  it("should give nothing for text without words", () => {
    expect(wordTimes("   ", 1)).toEqual([]);
  });
});

describe("trimSilence", () => {
  const rate = 1000;
  const tone = (ms: number) => Float32Array.from({ length: ms }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
  const silence = (ms: number) => new Float32Array(ms);
  const join = (...parts: Float32Array[]) => Float32Array.from(parts.flatMap((p) => [...p]));

  it("should cut the silence a voice leaves round a sentence, keeping a short margin so no word is clipped", () => {
    const trimmed = trimSilence(join(silence(300), tone(400), silence(500)), rate);
    expect(trimmed.length).toBeGreaterThanOrEqual(400);
    expect(trimmed.length).toBeLessThanOrEqual(400 + 2 * 60);
  });

  it("should leave a pause inside the sentence alone", () => {
    const inside = join(silence(100), tone(200), silence(250), tone(200), silence(100));
    expect(trimSilence(inside, rate).length).toBeGreaterThanOrEqual(650);
  });

  it("should return a short stretch, not nothing, for audio that is all silence", () => {
    expect(trimSilence(silence(500), rate).length).toBeLessThanOrEqual(80);
  });
});

describe("chunksOf", () => {
  it("should leave a short text whole", () => {
    expect(chunksOf("A short sentence.", 100)).toEqual(["A short sentence."]);
  });

  it("should cut a long text at the last pause before the limit, and lose nothing", () => {
    const text = "First part of it, second part of it; third part of it. Fourth and last part of it here";
    const chunks = chunksOf(text, 40);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text);
    expect(chunks[0]).toBe("First part of it, second part of it;");
  });

  it("should cut at a space when there is no punctuation, and by length when there is no space", () => {
    expect(chunksOf("one two three four five six", 12).every((c) => c.length <= 12)).toBe(true);
    expect(chunksOf("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("fastEnough", () => {
  it("should accept a computer that speaks well ahead of the voice and refuse one that would fall behind it", () => {
    expect(fastEnough(0.3)).toBe(true);
    expect(fastEnough(0.69)).toBe(true);
    expect(fastEnough(0.9)).toBe(false);
    expect(fastEnough(1.45)).toBe(false);
  });
});
