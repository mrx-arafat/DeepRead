import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WordAnswer } from "./WordPopover.tsx";

describe("WordAnswer", () => {
  const html = (text: string, status: "loading" | "done" | "error" = "done", fallback: string | null = null) =>
    renderToStaticMarkup(createElement(WordAnswer, { text, status, lang: "bn", fallback }));

  it("should show emphasis in the meaning and example as bold or italic, never as the asterisks the AI typed", () => {
    const answer = [
      "Bangla: সূক্ষ্ম পরীক্ষা",
      "Meaning: A *careful*, close look at something to find its faults.",
      "Example: The story **fell apart** under _scrutiny_.",
    ].join("\n");

    expect(html(answer)).toContain("<dd>A <em>careful</em>, close look at something to find its faults.</dd>");
    expect(html(answer)).toContain("<dd>The story <strong>fell apart</strong> under <em>scrutiny</em>.</dd>");
  });

  it("should show an emphasis that is still streaming in without its asterisks", () => {
    expect(html("Bangla: সূক্ষ্ম পরীক্ষা\nMeaning: A *caref", "loading")).toContain("<dd>A <em>caref</em></dd>");
  });

  it("should show the dictionary's translation exactly as it came when the tutor could not answer", () => {
    expect(html("", "error", "সূক্ষ্ম *পরীক্ষা*")).toContain('aria-live="polite">সূক্ষ্ম *পরীক্ষা*</p>');
  });
});
