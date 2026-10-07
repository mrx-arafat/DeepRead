import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_LANG } from "../shared/types.ts";
import type * as PrefsModule from "./prefs.ts";

let readPrefs: typeof PrefsModule.readPrefs;

beforeAll(async () => {
  // prefs.ts applies the saved look as it loads, so it needs a page to load into.
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("document", { documentElement: { dataset: {}, style: { setProperty: () => {} } } });
  ({ readPrefs } = await import("./prefs.ts"));
});

describe("readPrefs", () => {
  it("should keep known saved choices and replace unknown ones with the defaults", () => {
    const prefs = readPrefs(
      { lang: "xx", fontSize: 23, theme: "neon", font: 3, margins: "wide", align: "justify", layout: "pages", rate: 1.2, highlight: "purple" },
      false,
    );
    expect(prefs).toEqual({
      lang: DEFAULT_LANG,
      fontSize: 23,
      theme: "light",
      font: "serif",
      spacing: "normal",
      margins: "wide",
      align: "justify",
      layout: "pages",
      voice: "device",
      rate: 1.2,
      highlight: "yellow",
      chapterNotes: true,
    });
    expect(readPrefs({ highlight: "pink" }, false).highlight).toBe("pink");
  });

  it("should keep the natural voice when it was chosen, and fall back to the device voice for anything else", () => {
    expect(readPrefs({ voice: "natural" }, false).voice).toBe("natural");
    expect(readPrefs({ voice: "robot" }, false).voice).toBe("device");
    expect(readPrefs({}, false).voice).toBe("device");
  });

  it("should replace a text size, a speed or a language that is not one DeepRead offers", () => {
    const odd = readPrefs({ fontSize: "huge", rate: "fast", lang: "toString" }, false);
    expect([odd.fontSize, odd.rate, odd.lang]).toEqual([19, 1, DEFAULT_LANG]);
    expect(readPrefs({ fontSize: null, rate: Number.NaN }, false)).toMatchObject({ fontSize: 19, rate: 1 });
    expect(readPrefs({ fontSize: 18.5, rate: 1.1 }, false)).toMatchObject({ fontSize: 19, rate: 1 });
    expect(readPrefs({ lang: "__proto__" }, false).lang).toBe(DEFAULT_LANG);
  });

  it("should bring a text size beyond the Aa menu's range back to its nearest end", () => {
    expect(readPrefs({ fontSize: 4 }, false).fontSize).toBe(15);
    expect(readPrefs({ fontSize: 90 }, false).fontSize).toBe(26);
  });

  it("should keep every speed the player offers, including those of earlier versions", () => {
    for (const rate of [0.6, 0.8, 1, 1.2, 1.5]) expect(readPrefs({ rate }, false).rate).toBe(rate);
  });

  it("should read the book as one scroll unless pages were chosen", () => {
    expect(readPrefs(null, false).layout).toBe("scroll");
    expect(readPrefs({ layout: "columns" }, false).layout).toBe("scroll");
  });

  it("should show end-of-chapter notes unless the reader turned them off", () => {
    expect(readPrefs(null, false).chapterNotes).toBe(true);
    expect(readPrefs({ chapterNotes: false }, false).chapterNotes).toBe(false);
    expect(readPrefs({ chapterNotes: "false" }, false).chapterNotes).toBe(true);
  });

  it("should start a first-time reader on the system's light or dark", () => {
    expect(readPrefs(null, true).theme).toBe("dark");
    expect(readPrefs("not prefs", false).theme).toBe("light");
    expect(readPrefs({ theme: "sepia" }, true).theme).toBe("sepia");
  });
});
