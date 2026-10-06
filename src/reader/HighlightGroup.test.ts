import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HighlightColor } from "../../shared/types.ts";
import { HighlightGroup } from "./HighlightGroup.tsx";

describe("HighlightGroup", () => {
  const html = (color: HighlightColor, editing: boolean) =>
    renderToStaticMarkup(createElement(HighlightGroup, { color, editing, onPick: () => {}, onRemove: () => {} }));
  /** Each button's name, and whether it is pressed, in order. */
  const buttons = (markup: string) =>
    [...markup.matchAll(/<button[^>]*>/g)].map(([tag]) => {
      const label = /aria-label="([^"]+)"/.exec(tag)?.[1];
      const pressed = /aria-pressed="(true|false)"/.exec(tag)?.[1];
      return pressed ? `${label} (${pressed === "true" ? "pressed" : "not pressed"})` : label;
    });

  it("should offer the colour used last, then every colour by name with that one pressed", () => {
    expect(buttons(html("green", false))).toEqual([
      "Highlight in green",
      "Highlight yellow (not pressed)",
      "Highlight green (pressed)",
      "Highlight blue (not pressed)",
      "Highlight pink (not pressed)",
    ]);
  });

  it("should offer to change the colour of the highlight a selection lies in, or to remove it", () => {
    expect(buttons(html("pink", true))).toEqual([
      "Highlight yellow (not pressed)",
      "Highlight green (not pressed)",
      "Highlight blue (not pressed)",
      "Highlight pink (pressed)",
      "Remove highlight",
    ]);
    expect(html("pink", true)).toContain('aria-label="Change highlight"');
  });
});
