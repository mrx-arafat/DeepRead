import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { handoffLink } from "./handoff.ts";
import { HandoffControl } from "./HandoffControl.tsx";

const link = handoffLink("claude", {
  bookTitle: "The Problems of Philosophy", author: null, chapterTitle: "I", language: "Bangla", before: null, paragraph: "The table is brown.", selection: "brown",
});

describe("HandoffControl", () => {
  it("should open the chosen chat from its main part and list every chat in a menu with the chosen one marked", () => {
    const html = renderToStaticMarkup(<HandoffControl link={link} where="card" onChoose={() => {}} onSent={() => {}} />);
    expect(html).toContain('href="https://claude.ai/new?q=');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Go deeper with");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(6);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    for (const name of ["ChatGPT", "Claude", "Perplexity", "Google AI Mode", "Gemini", "Copy prompt"]) expect(html).toContain(name);
  });
});
