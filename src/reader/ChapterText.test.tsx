import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Block } from "../../shared/types.ts";
import { ChapterText, type TextActions } from "./ChapterText.tsx";

const actions: TextActions = {
  onWord: () => {}, onSelect: () => {}, onDismiss: () => {}, onCloseNote: () => {}, onSaveAnswer: () => {},
};
const asset = `figures/${"a".repeat(64)}.png`;
const figure: Block = { id: "c1-figure", type: "image", page: 1, text: "", image: { src: asset, width: 800, height: 600, alt: "A plotted curve" } };
const render = (blocks: Block[]) => renderToStaticMarkup(<ChapterText blocks={blocks} notes={[]} bookId="shared-book" chapterId="c1" actions={actions} />);

describe("preserved book content", () => {
  it("renders source alignment, relative size, font category and overlapping inline emphasis safely", () => {
    const html = render([{ id: "styled", type: "paragraph", page: 1, text: "Bold italic <safe>", style: { align: "right", fontFamily: "sans-serif", fontSize: 1.1 }, runs: [
      { start: 0, end: 11, bold: true }, { start: 5, end: 11, italic: true, underline: true },
    ] }]);
    expect(html).toContain('style="text-align:right;font-family:var(--font-ui);font-size:1.1em"');
    expect(html).toContain('<span style="font-weight:700">Bold </span>');
    expect(html).toContain('<span style="font-weight:700;font-style:italic;text-decoration:underline">italic</span>');
    expect(html).toContain(" &lt;safe&gt;");
    expect(html).not.toContain("<safe>");
  });

  it("renders semantic table cells with source delimiters and cell emphasis", () => {
    const html = render([{ id: "table", type: "table", page: 1, text: "A\tB\nC\tD", rows: [["A", "B"], ["C", "D"]], runs: [{ start: 2, end: 3, bold: true }] }]);
    expect(html).toContain('<table aria-label="Table on page 1"><tbody><tr><td>A');
    expect(html).toContain('<span style="font-weight:700">B</span>');
    expect(html).toContain('class="book-table-separator" aria-hidden="true">\t</span>');
    expect(html).toContain('class="book-table-separator" aria-hidden="true">\n</span>');
    expect(html).toContain('data-block="table" tabindex="0"');
  });

  it("ignores invalid style ranges without dropping or rewriting book text", () => {
    expect(render([{ id: "bad", type: "paragraph", page: 1, text: "Exact words", runs: [{ start: -1, end: 4, bold: true }, { start: 0, end: 200, italic: true }] }]))
      .toContain('data-block="bad" tabindex="0">Exact words</p>');
  });
  it("renders a private figure in reading order without making it a selectable text block", () => {
    const html = render([figure, { id: "c1-b1", type: "paragraph", text: "The caption follows.", page: 1 }]);
    expect(html).toContain(`src="/api/books/shared-book/${asset}"`);
    expect(html).toContain('alt="A plotted curve"');
    expect(html).toContain('width="800" height="600"');
    expect(html).toContain('data-book-figure="c1-figure"');
    expect(html).not.toContain('data-block="c1-figure"');
    expect(html.indexOf("<figure")).toBeLessThan(html.indexOf("The caption follows."));
    expect(html).toContain('data-block="c1-b1" tabindex="0"');
  });

  it("preserves code whitespace and escapes markup in one text node", () => {
    const html = render([{ id: "c1-code", type: "code", page: 1, text: "if (x < 2) {\n  return '<script>';\n}" }]);
    expect(html).toContain('<pre class="book-code" data-block="c1-code" tabindex="0">if (x &lt; 2) {\n  return &#x27;&lt;script&gt;&#x27;;\n}</pre>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<span");
  });

  it("retains a list's printed marker and selectable offsets", () => {
    expect(render([{ id: "c1-item", type: "paragraph", format: "list-item", page: 1, text: "2. Follow the path." }]))
      .toContain('<p class="book-list-item" data-block="c1-item" tabindex="0">2. Follow the path.</p>');
  });

  it.each(["https://example.com/tracker.png", "../source.pdf", "figures/../../secret.png", "data:image/svg+xml,<svg/>", "javascript:alert(1)"])("refuses untrusted figure source %s", (src) => {
    expect(render([{ ...figure, image: { ...figure.image!, src } }])).not.toContain("<img");
  });
});
