import { describe, expect, it } from "vitest";
import { menuOpensAbove } from "./BookMenu.tsx";

describe("More actions placement", () => {
  it.each([
    { triggerTop: 810, triggerBottom: 854, panelHeight: 98, viewportHeight: 900, above: true },
    { triggerTop: 770, triggerBottom: 814, panelHeight: 98, viewportHeight: 844, above: true },
    { triggerTop: 300, triggerBottom: 344, panelHeight: 98, viewportHeight: 900, above: false },
  ])("keeps both actions visible at $viewportHeight px", ({ triggerTop, triggerBottom, panelHeight, viewportHeight, above }) => {
    expect(menuOpensAbove(triggerTop, triggerBottom, panelHeight, viewportHeight)).toBe(above);
  });
});
