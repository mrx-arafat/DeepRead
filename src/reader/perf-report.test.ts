import { afterEach, expect, it, vi } from "vitest";
import { startPerfReport } from "./perf-report.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("keeps only bounded recent timings and samples, copies locally, and releases recording resources", async () => {
  vi.useFakeTimers();
  const observers: Array<{ type: string; receive: (list: { getEntries: () => object[] }) => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  class Observer {
    static supportedEntryTypes = ["longtask", "event"];
    type = "";
    disconnect = vi.fn();
    readonly receive: (list: { getEntries: () => object[] }) => void;
    constructor(receive: (list: { getEntries: () => object[] }) => void) { this.receive = receive; observers.push(this); }
    observe(options: { type: string }): void { this.type = options.type; }
  }
  const button = { style: { cssText: "" }, setAttribute: vi.fn(), remove: vi.fn(), onclick: null as (() => Promise<void>) | null };
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("PerformanceObserver", Observer);
  vi.stubGlobal("performance", { now: () => 10, timeOrigin: 1000 });
  vi.stubGlobal("navigator", { userAgent: "test device", hardwareConcurrency: 4, clipboard: { writeText } });
  vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 20, setInterval, clearInterval });
  vi.stubGlobal("document", {
    createElement: () => button,
    body: { append: vi.fn() },
    documentElement: { dataset: { tier: "low" } },
    getElementsByTagName: () => ({ length: 99 }),
    querySelectorAll: (selector: string) => ({ length: selector === ".text-chunk" ? 5 : selector.includes("placeholder") ? 3 : 1 }),
  });
  const stop = startPerfReport();
  observers.find((item) => item.type === "longtask")!.receive({ getEntries: () => Array.from({ length: 405 }, (_, i) => ({ startTime: 10 + i, duration: 60, name: "task" })) });
  observers.find((item) => item.type === "event")!.receive({ getEntries: () => [
    { startTime: 12, duration: 100, name: "click", processingStart: 20, processingEnd: 25 },
    { startTime: 13, duration: 120, name: "pointerup", processingStart: 20, processingEnd: 35 },
  ] });
  vi.advanceTimersByTime(802_000);
  await button.onclick!();
  const report = JSON.parse(writeText.mock.calls[0]![0] as string);
  expect(report.frames).toHaveLength(400);
  expect(report.frames[0].startTime).toBe(15);
  expect(report.events).toEqual([{ name: "pointerup", startTime: 13, duration: 120, processingTime: 15 }]);
  expect(report.samples).toHaveLength(400);
  expect(report.samples[0]).toMatchObject({ domNodes: 99, chunks: { mounted: 2, placeholders: 3 }, mountedChapters: 1, memory: null, tier: "low" });
  expect(report.support).toEqual({ "long-animation-frame": "unsupported", longtask: "recording", event: "recording" });
  stop();
  expect(observers.every((item) => item.disconnect.mock.calls.length === 1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(button.remove).toHaveBeenCalledOnce();
});
