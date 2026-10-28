import { describe, expect, it, vi } from "vitest";
import { TranslationCache, registerTranslationPriority, queueTranslationRequest, translationApplied, setTranslationPriority } from "./translationCache.ts";
import { refreshDeviceTier } from "../deviceTier.ts";

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

  it("should shrink existing cache entries to the low-tier character and entry budgets", () => {
    const cache = new TranslationCache();
    cache.set("large", { b: "x".repeat(600_001) });
    refreshDeviceTier({ override: "on" });
    try {
      expect(cache.has("large")).toBe(false);
      for (let index = 0; index < 13; index++) cache.set(String(index), { b: "text" });
      expect(cache.has("0")).toBe(false);
      expect(cache.has("1")).toBe(true);
      expect(cache.has("12")).toBe(true);
    } finally { refreshDeviceTier({ override: "auto" }); }
  });
});

it("should drop aborted queued work and prioritize a newly current chapter with the normal-tier limit", async () => {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  refreshDeviceTier();
  const controller = new AbortController();
  const cancelled = new AbortController();
  const unregister = registerTranslationPriority("priority", "normal", false);
  const started: string[] = [];
  const finish: Array<() => void> = [];
  const start = (key: string) => () => {
    started.push(key);
    return new Promise<void>((resolve) => finish.push(resolve));
  };
  try {
    queueTranslationRequest("first", "normal", controller.signal, start("first"));
    queueTranslationRequest("second", "normal", controller.signal, start("second"));
    queueTranslationRequest("cancelled", "normal", cancelled.signal, start("cancelled"));
    queueTranslationRequest("priority", "normal", controller.signal, start("priority"));
    cancelled.abort();
    setTranslationPriority("priority", true);
    await Promise.resolve();
    expect(started).toEqual(["priority", "first"]);
    finish.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["priority", "first", "second"]);
  } finally {
    controller.abort();
    finish.forEach((resolve) => resolve());
    await Promise.resolve();
    unregister();
    vi.unstubAllGlobals();
    refreshDeviceTier();
  }
});

it("should prioritize the eye-line chapter and issue neighbours at idle only after it is applied", async () => {
  refreshDeviceTier({ override: "on" });
  const idle: Array<() => void> = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void, options: IdleRequestOptions) => {
    expect(options.timeout).toBe(2000);
    idle.push(callback);
    return idle.length;
  });
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const unregister = registerTranslationPriority("eye", "context", true);
  const neighbour = registerTranslationPriority("next", "context", false);
  const controller = new AbortController();
  const started: string[] = [];
  let finish!: () => void;
  try {
    queueTranslationRequest("next", "context", controller.signal, async () => { started.push("next"); });
    queueTranslationRequest("eye", "context", controller.signal, () => {
      started.push("eye");
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    await Promise.resolve();
    expect(started).toEqual(["eye"]);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(idle).toHaveLength(0);
    translationApplied("eye");
    await Promise.resolve();
    expect(idle).toHaveLength(1);
    expect(started).toEqual(["eye"]);
    idle[0]!();
    expect(started).toEqual(["eye", "next"]);
    await Promise.resolve();
  } finally {
    controller.abort();
    unregister();
    neighbour();
    refreshDeviceTier({ override: "auto" });
    vi.unstubAllGlobals();
  }
});
