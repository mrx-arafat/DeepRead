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
      { lang: "xx", fontSize: 23, theme: "neon", font: 3, margins: "wide", align: "justify", rate: 1.25 },
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
      rate: 1.25,
    });
  });

  it("should start a first-time reader on the system's light or dark", () => {
    expect(readPrefs(null, true).theme).toBe("dark");
    expect(readPrefs("not prefs", false).theme).toBe("light");
    expect(readPrefs({ theme: "sepia" }, true).theme).toBe("sepia");
  });
});
