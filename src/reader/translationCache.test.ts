import { describe, expect, it } from "vitest";
import { TranslationCache } from "./translationCache.ts";

describe("translation cache", () => {
  it("keeps recently read chapters and evicts the least recently used", () => {
    const cache = new TranslationCache(2, 100);
    cache.set("one", { b: "one" });
    cache.set("two", { b: "two" });
    expect(cache.get("one")).toEqual({ b: "one" });
    cache.set("three", { b: "three" });
    expect(cache.has("two")).toBe(false);
    expect(cache.has("one")).toBe(true);
  });

  it("bounds retained characters and counts replacement entries once", () => {
    const cache = new TranslationCache(40, 10);
    cache.set("one", { b: "12345" });
    cache.set("two", { b: "67890" });
    cache.set("one", { b: "123" });
    cache.set("three", { b: "abc" });
    expect(cache.has("two")).toBe(false);
    expect(cache.get("one")).toEqual({ b: "123" });
    expect(cache.has("three")).toBe(true);
    cache.set("huge", { b: "x".repeat(11) });
    expect(cache.has("huge")).toBe(false);
    expect(cache.has("one")).toBe(true);
  });
});
