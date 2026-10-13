import { afterEach, describe, expect, it, vi } from "vitest";
import { manageMobileRowRendering } from "./useMobileRowRendering.ts";

function harness() {
  const events: string[] = [];
  const style = () => {
    const values = new Map<string, string>();
    return { getPropertyValue: (key: string) => values.get(key) ?? "", setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) };
  };
  const rows = [120.5, 260, 380].map((height, index) => ({
    height, style: style(), measured: false, content: index === 2 ? "note" : "text",
    getBoundingClientRect() { events.push(`read-${index}`); return { height: this.height }; },
    querySelector(selector: string) {
      return this.content === "note" || this.content === "unknown-figure" || (this.content === "fixed-figure" && !selector.includes(":not([data-fixed-size])")) ? {} : null;
    },
    setAttribute() { events.push(`enable-${index}`); this.measured = true; },
    removeAttribute() { this.measured = false; },
  }));
  const attrs = new Map<string, string>();
  const root = { dataset: { layout: "scroll" }, style: style(), getAttribute: (key: string) => attrs.get(key) ?? null };
  const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  let mutation = () => {};
  let resize = () => {};
  class Mutation { constructor(callback: () => void) { mutation = callback; } observe() {} disconnect() {} }
  class Resize { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} }
  const fonts = { status: "loaded", addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const container = { width: 350, querySelectorAll: () => rows, getBoundingClientRect() { return { width: this.width }; } };
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("document", { documentElement: root, fonts, querySelectorAll: () => [] });
  vi.stubGlobal("window", { matchMedia: () => media, innerWidth: 390, scrollBy: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { callback(); return 1; });
  vi.stubGlobal("MutationObserver", Mutation);
  vi.stubGlobal("ResizeObserver", Resize);
  return { rows, events, root, attrs, media, fonts, container: container as unknown as HTMLElement & { width: number }, mutation: () => mutation(), resize: () => resize() };
}

afterEach(() => vi.unstubAllGlobals());

describe("mobile retained row rendering", () => {
  it("skips fixed-aspect-ratio figures while retaining ordinary layout for unknown-sized figures", () => {
    const page = harness();
    page.rows[0]!.content = "fixed-figure";
    page.rows[1]!.content = "unknown-figure";
    const stop = manageMobileRowRendering(page.container);
    expect(page.rows.map(row => row.measured)).toEqual([true, false, false]);
    stop();
  });
  it("batches actual height reads before enabling static chunks and leaves dynamic content alone", () => {
    const page = harness();
    const stop = manageMobileRowRendering(page.container);
    expect(page.events).toEqual(["read-0", "read-1", "enable-0", "enable-1"]);
    expect(page.rows.map((row) => row.style.getPropertyValue("--text-chunk-size"))).toEqual(["120.5px", "260px", ""]);
    expect(page.rows[2]!.measured).toBe(false);
    stop();
    expect(page.rows.every((row) => !row.measured && !row.style.getPropertyValue("--text-chunk-size"))).toBe(true);
  });

  it("invalidates typography and width changes without remeasuring unrelated root styles or height-only resize", () => {
    const page = harness();
    const stop = manageMobileRowRendering(page.container);
    page.events.length = 0;
    page.root.style.setProperty("overflow-anchor", "none");
    page.mutation();
    page.resize();
    expect(page.events).toEqual([]);
    page.rows[0]!.height = 150;
    page.root.style.setProperty("--book-size", "23px");
    page.mutation();
    expect(page.rows[0]!.style.getPropertyValue("--text-chunk-size")).toBe("150px");
    page.rows[0]!.height = 175;
    page.container.width = 300;
    page.resize();
    expect(page.rows[0]!.style.getPropertyValue("--text-chunk-size")).toBe("175px");
    page.root.dataset.layout = "pages";
    page.attrs.set("data-layout", "pages");
    page.mutation();
    expect(page.rows.every((row) => !row.measured)).toBe(true);
    page.root.dataset.layout = "scroll";
    page.attrs.set("data-layout", "scroll");
    page.mutation();
    expect(page.rows[0]!.measured).toBe(true);
    page.media.matches = true;
    page.media.addEventListener.mock.calls[0]![1]();
    expect(page.rows.every((row) => !row.measured)).toBe(true);
    stop();
  });

  it("refreshes after font loading and falls back without observer setup on unsupported browsers", () => {
    const page = harness();
    const stop = manageMobileRowRendering(page.container);
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => page.rows[0]!.style.getPropertyValue("--text-chunk-size") === "190px" ? { top: 196, bottom: 296 } : { top: 96, bottom: 196 },
    };
    const chunk = { getBoundingClientRect: () => ({ top: 0, bottom: 1000 }), querySelectorAll: () => [anchor] };
    vi.stubGlobal("document", { documentElement: page.root, fonts: page.fonts, querySelectorAll: () => [chunk] });
    page.rows[0]!.height = 190;
    page.fonts.addEventListener.mock.calls[0]![1]();
    expect(page.rows[0]!.style.getPropertyValue("--text-chunk-size")).toBe("190px");
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 100, behavior: "instant" });
    stop();
    page.events.length = 0;
    vi.stubGlobal("CSS", { supports: () => false });
    manageMobileRowRendering(page.container)();
    expect(page.events).toEqual([]);
  });
});
