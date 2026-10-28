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

  it("should write the new tier to data-tier when a measurement promotes the device", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { deviceMemory: 8, hardwareConcurrency: 8 });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const root = { dataset: { tier: "normal" } as Record<string, string> };
    vi.stubGlobal("document", { documentElement: root });
    const { deviceTier, refreshDeviceTier } = await import("./deviceTier.ts");
    expect(deviceTier()).toBe("normal");
    refreshDeviceTier({ measured: true });
    expect(root.dataset.tier).toBe("low");
  });
});

describe("long-frame measurement", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // A phone on a book page whose first chapter is already there: the measurement runs, and `send` delivers frames to it.
  // Fake timers run 60 s before the frames arrive, so any window that disconnects the observer would show.
  async function measuringPhone() {
    vi.resetModules();
    vi.useFakeTimers();
    let deliver: (entries: { duration: number; startTime: number }[]) => void = () => {};
    class FrameObserver {
      static supportedEntryTypes = ["long-animation-frame"];
      private connected = true;
      constructor(callback: (list: { getEntries: () => unknown[] }) => void) {
        deliver = (entries) => {
          if (this.connected) callback({ getEntries: () => entries });
        };
      }
      observe() {}
      disconnect() {
        this.connected = false;
      }
    }
    vi.stubGlobal("PerformanceObserver", FrameObserver);
    vi.stubGlobal("MutationObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), location: { pathname: "/book/a/one" } });
    vi.stubGlobal("navigator", { deviceMemory: 8, hardwareConcurrency: 8 });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal("document", { documentElement: root, querySelector: () => ({}), body: {} });
    const { refreshDeviceTier } = await import("./deviceTier.ts");
    refreshDeviceTier();
    vi.advanceTimersByTime(60_000);
    // Far past the settle and past the first 20 seconds, so the frames count whenever they come.
    return { root, later: performance.now() + 60_000, send: (entries: { duration: number; startTime: number }[]) => deliver(entries) };
  }

  it("should promote a phone at once on a single frame of 400 ms that starts after the settle", async () => {
    const { root, later, send } = await measuringPhone();
    send([{ duration: 450, startTime: later }]);
    expect(root.dataset.tier).toBe("low");
  });

  it("should count 100 ms frames over the whole session and promote on the fifth", async () => {
    const { root, later, send } = await measuringPhone();
    for (let frame = 0; frame < 4; frame += 1) send([{ duration: 150, startTime: later + frame }]);
    expect(root.dataset.tier).toBe("normal");
    send([{ duration: 150, startTime: later + 4 }]);
    expect(root.dataset.tier).toBe("low");
  });
});
