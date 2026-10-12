import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourcePageText, SourcePageTextRun } from "../../shared/source-page.ts";
import { readSourcePageText, sourcePageCopyText, SourcePageTextLayer } from "./SourcePageText.tsx";

const run = (text: string, change: Partial<SourcePageTextRun> = {}): SourcePageTextRun => ({ text, x: 0.1, y: 0.1, width: 0.1, height: 0.02, fontSize: 0.02, angle: 0, dir: "ltr", source: "native", ...change });
const page = (runs: SourcePageTextRun[]): SourcePageText => ({ width: 1000, height: 1000, runs });

describe("source page selectable text", () => {
  it("accepts native and OCR runs including rotated spans that start outside the page", () => {
    const data = page([run("Native", { x: -0.01, angle: 90 }), run("Recovered", { source: "ocr", y: 0.2 })]);
    expect(readSourcePageText(data)).toBe(data);
    expect(readSourcePageText(page([]))).toEqual(page([]));
  });

  it.each([
    { x: Number.NaN }, { width: Number.POSITIVE_INFINITY }, { fontSize: 0 }, { angle: "90" },
    { source: "unknown" }, { dir: "sideways" }, { fontFamily: "url(https://tracker)" }, { hasEOL: "true" },
  ])("rejects malformed run geometry or metadata %o", (change) => {
    expect(readSourcePageText(page([run("Words", change as Partial<SourcePageTextRun>)]))).toBeNull();
  });

  it("preserves spaces, embedded run whitespace and explicit line breaks for copying", () => {
    expect(sourcePageCopyText(page([
      run("Hello"), run("world", { x: 0.21, hasEOL: true }),
      run("already spaced ", { y: 0.2 }), run("text", { x: 0.21, y: 0.2 }),
    ]))).toBe("Hello world\nalready spaced text");
  });

  it("keeps split word glyphs together while separating words on a rotated baseline", () => {
    expect(sourcePageCopyText(page([run("hel"), run("lo", { x: 0.2 })]))).toBe("hello");
    expect(sourcePageCopyText(page([
      run("First", { x: 0.5, y: 0.1, angle: 90 }), run("second", { x: 0.5, y: 0.21, angle: 90 }),
    ]))).toBe("First second");
  });

  it("escapes document text and renders only positioned, selectable, accessible spans", () => {
    const html = renderToStaticMarkup(<SourcePageTextLayer page={page([run("<script>", { fontFamily: "monospace", x: 0.2, y: 0.3, angle: 90, hasEOL: true })])} />);
    expect(html).toContain('data-source-page-text="true" role="document" aria-label="Selectable original page text"');
    expect(html).toContain('data-source-text-run="true" dir="ltr"');
    expect(html).toContain('style="left:20%;top:30%;font-family:monospace;transform:rotate(90deg)"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('class="source-page-text-separator">\n</span>');
  });
});
