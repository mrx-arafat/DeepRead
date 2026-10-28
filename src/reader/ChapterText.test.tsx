import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../shared/types.ts";
import { refreshDeviceTier } from "../deviceTier.ts";
import { ChapterText, type TextActions } from "./ChapterText.tsx";

const actions: TextActions = {
  onWord: () => {}, onSelect: () => {}, onDismiss: () => {}, onCloseNote: () => {}, onSaveAnswer: () => {},
};
const asset = `figures/${"a".repeat(64)}.png`;
const figure: Block = { id: "c1-figure", type: "image", page: 1, text: "", image: { src: asset, width: 800, height: 600, alt: "A plotted curve" } };
const render = (blocks: Block[]) => renderToStaticMarkup(<ChapterText blocks={blocks} notes={[]} bookId="shared-book" chapterId="c1" actions={actions} />);

describe("preserved book content", () => {
  it("isolates figures so illustrated prose remains skippable without changing order or heading levels", () => {
    const html = render([
      { id: "before", type: "paragraph", page: 1, text: "Before" }, figure,
      { id: "after", type: "heading", level: 1, page: 1, text: "After" },
    ]);
    expect(html.match(/class="text-chunk"/g)).toHaveLength(3);
    expect(html).toContain('<h3 data-block="after"');
    expect(html.indexOf('data-block="before"')).toBeLessThan(html.indexOf("<figure"));
    expect(html.indexOf("<figure")).toBeLessThan(html.indexOf('data-block="after"'));
  });

  it("offers downsampled figure sources with an original fallback and stable printed dimensions", () => {
    const html = render([{ ...figure, image: { ...figure.image!, width: 2000, height: 1500 } }]);
    expect(html).toContain(`${asset}?width=480 480w`);
    expect(html).toContain(`${asset}?width=960 960w`);
    expect(html).toContain(`${asset}?width=1440 1440w`);
    expect(html).toContain(`${asset} 2000w`);
    expect(html).toContain('sizes="auto,');
    expect(html).toContain('width="2000" height="1500"');
    expect(html).toContain('width:min(100%, 2000px)');
    expect(render([{ ...figure, image: { ...figure.image!, width: 320 } }])).not.toContain("srcSet=");
  });

  it("groups retained rows into bounded rendering chunks and preserves headings at their boundaries", () => {
    const blocks: Block[] = Array.from({ length: 97 }, (_, at) => ({ id: `b${at}`, type: at === 48 ? "heading" : "paragraph", page: 1, text: `Source ${at}`, ...(at === 48 ? { level: 1 } : {}) }));
    const html = render(blocks);
    expect(html.match(/class="text-chunk"/g)).toHaveLength(3);
    expect(html.match(/class="row"/g)).toHaveLength(97);
    expect(html).toContain('<h3 data-block="b48"');
    expect(html.indexOf('data-block="b47"')).toBeLessThan(html.indexOf('data-block="b48"'));
    expect(html.indexOf('data-block="b48"')).toBeLessThan(html.indexOf('data-block="b49"'));
  });

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
      .toContain('data-block="bad" tabindex="0" id="bad" data-chars-before="0">Exact words</p>');
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
    expect(html).toContain('<pre class="book-code" data-block="c1-code" tabindex="0" id="c1-code" data-chars-before="0">if (x &lt; 2) {\n  return &#x27;&lt;script&gt;&#x27;;\n}</pre>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<span");
  });

  it("retains a list's printed marker and selectable offsets", () => {
    expect(render([{ id: "c1-item", type: "paragraph", format: "list-item", page: 1, text: "2. Follow the path." }]))
      .toContain('<p class="book-list-item" data-block="c1-item" tabindex="0" id="c1-item" data-chars-before="0">2. Follow the path.</p>');
  });

  it("counts the chapter text before each block, skipping figures, so progress needs no walk over the rows", () => {
    const html = render([{ id: "a", type: "paragraph", page: 1, text: "Twelve chars" }, figure, { id: "b", type: "heading", level: 1, page: 1, text: "Head" }, { id: "c", type: "paragraph", page: 1, text: "Last" }]);
    expect(html).toContain('data-block="a" tabindex="0" id="a" data-chars-before="0"');
    expect(html).toContain('data-block="b" tabindex="-1" id="b" data-chars-before="12"');
    expect(html).toContain('data-block="c" tabindex="-1" id="c" data-chars-before="16"');
    expect(html).toContain('data-book-figure="c1-figure" data-fixed-size="" id="c1-figure"');
  });
});

describe("chunk window", () => {
  afterEach(() => {
    refreshDeviceTier({ override: "auto" });
  });
  const many = (count: number): Block[] => Array.from({ length: count }, (_, at) => ({ id: `b${at}`, type: "paragraph", page: 1, text: `Source ${at}` }));
  const renderAt = (blocks: Block[], openAt?: string) =>
    renderToStaticMarkup(<ChapterText blocks={blocks} notes={[]} bookId="shared-book" chapterId="c1" actions={actions} openAt={openAt} />);

  it("keeps every row on the page on the desktop tier, with chunks out of the layout", () => {
    const html = renderAt(many(100));
    expect(html.match(/class="row"/g)).toHaveLength(100);
    expect(html.match(/class="text-chunk" data-chunk="b\d+"/g)).toHaveLength(3);
    expect(html).not.toContain("data-window");
    expect(html).not.toContain("data-placeholder");
  });

  it("opens a phone with the first chunks as rows and the rest as placeholders of a height", () => {
    refreshDeviceTier({ override: "on" });
    const html = renderAt(many(100));
    expect(html.match(/class="row"/g)).toHaveLength(48);
    expect(html.match(/data-chunk="b\d+" data-window=""/g)).toHaveLength(5);
    expect(html.match(/data-placeholder="" style="height:\d+px"/g)).toHaveLength(3);
    expect(html).toContain('data-chunk="b0" data-window=""><div class="row">');
    expect(html).toContain('data-chunk="b48" data-window="" data-placeholder=""');
  });

  it("opens a phone with the rows around the saved place as well", () => {
    refreshDeviceTier({ override: "on" });
    const html = renderAt(many(100), "b70");
    expect(html).toContain('data-chunk="b48" data-window=""><div class="row">');
    expect(html).toContain('data-chunk="b72" data-window=""><div class="row">');
    expect(html).toContain('data-chunk="b96" data-window="" data-placeholder=""');
    expect(html.match(/class="row"/g)).toHaveLength(96);
  });

  it("never leaves a chunk with a note card as a placeholder", () => {
    refreshDeviceTier({ override: "on" });
    const note = { id: "n1", chapterId: "c1", blockId: "b90", quote: "Source 90", mode: "simple" as const, lang: "bn" as const };
    const html = renderToStaticMarkup(<ChapterText blocks={many(100)} notes={[note]} bookId="shared-book" chapterId="c1" actions={actions} />);
    expect(html).toContain('data-chunk="b72" data-window=""><div class="row">');
    expect(html).toContain('data-note="n1"');
  });

  it.each(["https://example.com/tracker.png", "../source.pdf", "figures/../../secret.png", "data:image/svg+xml,<svg/>", "javascript:alert(1)"])("refuses untrusted figure source %s", (src) => {
    expect(render([{ ...figure, image: { ...figure.image!, src } }])).not.toContain("<img");
  });
});
