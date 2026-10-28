import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTier, type TierSignals } from "./deviceTier.ts";

const phone = (signals: Partial<TierSignals> = {}): TierSignals => ({ finePointer: false, wideViewport: false, saveData: false, ...signals });
const desktop = (signals: Partial<TierSignals> = {}): TierSignals => ({ finePointer: true, wideViewport: true, saveData: false, ...signals });

describe("resolveTier", () => {
  it.each([
    ["a 2 GiB phone is low", phone({ deviceMemory: 2 }), "auto", false, "low"],
    ["a 4 GiB phone is normal", phone({ deviceMemory: 4 }), "auto", false, "normal"],
    ["a touch screen with 4 cores and no memory figure is low", phone({ hardwareConcurrency: 4 }), "auto", false, "low"],
    ["Save-Data makes a 4 GiB phone low", phone({ deviceMemory: 4, saveData: true }), "auto", false, "low"],
    ["a fine pointer on a wide screen is the desktop, whatever its memory", desktop({ deviceMemory: 2 }), "auto", false, "desktop"],
    ["a measured phone is promoted to low", phone({ deviceMemory: 8 }), "auto", true, "low"],
    ["a measurement never promotes the desktop", desktop({ deviceMemory: 8 }), "auto", true, "desktop"],
    ["override On is low, even on the desktop", desktop(), "on", false, "low"],
    ["override Off keeps a 2 GiB phone normal", phone({ deviceMemory: 2 }), "off", true, "normal"],
    ["override Off keeps the desktop as it is", desktop({ deviceMemory: 2 }), "off", false, "desktop"],
  ] as const)("should resolve the tier when %s", (_name, signals, override, measured, expected) => {
    expect(resolveTier(signals, override, measured)).toBe(expected);
  });
});

describe("deviceTier storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function tierWith(stored: string | null): Promise<string> {
    vi.resetModules();
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { deviceMemory: 4, hardwareConcurrency: 8 });
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem: () => {}, removeItem: () => {} });
    const { deviceTier } = await import("./deviceTier.ts");
    return deviceTier();
  }

  it("should keep a measurement from the last 30 days", async () => {
    expect(await tierWith(JSON.stringify({ measuredLow: true, at: Date.now() - 24 * 60 * 60 * 1000 }))).toBe("low");
  });

  it("should forget a measurement older than 30 days", async () => {
    expect(await tierWith(JSON.stringify({ measuredLow: true, at: Date.now() - 31 * 24 * 60 * 60 * 1000 }))).toBe("normal");
  });
});
