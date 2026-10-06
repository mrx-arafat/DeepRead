import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { faviconHref, faviconSvg, RIBBON, TEXT_LINES } from "./favicon.ts";

describe("faviconSvg", () => {
  it("should wear the cover's deep red in light, a warmer rust in sepia, and the brighter dark-theme red in dark", () => {
    expect(faviconSvg("light")).toContain('fill="#7a2e2b"');
    expect(faviconSvg("sepia")).toContain('fill="#8a3f22"');
    expect(faviconSvg("dark")).toContain('fill="#a03c39"');
    expect(faviconSvg("dark")).not.toContain("#7a2e2b");
    // The cream ribbon and lines are the same in all three: only the cloth moves with the theme.
    for (const theme of ["light", "sepia", "dark"] as const) {
      expect(faviconSvg(theme)).toContain(RIBBON);
      expect(faviconSvg(theme)).toContain(TEXT_LINES);
      expect(faviconSvg(theme)).toContain("#fbf5e6");
    }
  });

  it("should be a data address a link can point to, that decodes back to the drawing", () => {
    const href = faviconHref("dark");
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(href.slice("data:image/svg+xml,".length))).toBe(faviconSvg("dark"));
  });

  it("should draw the same ribbon and lines as the file the page starts with, so the two cannot drift apart", () => {
    const file = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
    expect(file).toContain(RIBBON);
    expect(file).toContain(TEXT_LINES);
  });
});
