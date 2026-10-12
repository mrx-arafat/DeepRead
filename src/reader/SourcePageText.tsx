import { useLayoutEffect, useRef } from "react";
import type { SourcePageText, SourcePageTextRun } from "../../shared/source-page.ts";

const finite = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** Reject malformed geometry before it becomes positioned DOM or a very large text overlay. */
export function readSourcePageText(value: unknown): SourcePageText | null {
  if (!value || typeof value !== "object") return null;
  const source = value as SourcePageText;
  if (!finite(source.width, 1, 100_000) || !finite(source.height, 1, 100_000) || !Array.isArray(source.runs) || source.runs.length > 20_000) return null;
  let characters = 0;
  for (const run of source.runs) {
    // Native rotated text can start outside the page while its glyphs still intersect the image.
    if (!run || typeof run.text !== "string" || !finite(run.x, -32, 32) || !finite(run.y, -32, 32) || !finite(run.width, 0, 64) || !finite(run.height, 0, 64) || !finite(run.fontSize, 0.00001, 8) || !finite(run.angle, -360, 360) || !["ltr", "rtl"].includes(run.dir) || !["native", "ocr"].includes(run.source) || (run.hasEOL !== undefined && typeof run.hasEOL !== "boolean") || (run.fontFamily !== undefined && !["serif", "sans-serif", "monospace"].includes(run.fontFamily))) return null;
    characters += run.text.length;
    if (characters > 500_000) return null;
  }
  if (source.warning !== undefined && typeof source.warning !== "string") return null;
  return source;
}

function separator(run: SourcePageTextRun, next: SourcePageTextRun | undefined, page: SourcePageText): string {
  if (run.hasEOL) return "\n";
  if (!next || /\s$/.test(run.text) || /^\s/.test(next.text)) return "";
  const angle = run.angle * Math.PI / 180;
  const dx = (next.x - run.x) * page.width;
  const dy = (next.y - run.y) * page.height;
  const along = dx * Math.cos(angle) + dy * Math.sin(angle);
  const across = -dx * Math.sin(angle) + dy * Math.cos(angle);
  if (Math.abs(across) > Math.max(run.height, next.height) * page.height * 0.6 && Math.abs(run.angle - next.angle) < 1) return "\n";
  const gap = run.dir === "rtl" ? -along - next.width * page.width : along - run.width * page.width;
  return gap > run.fontSize * page.height * 0.12 ? " " : "";
}

export function sourcePageCopyText(page: SourcePageText): string {
  return page.runs.map((run, index) => run.text + separator(run, page.runs[index + 1], page)).join("");
}

function family(name: string | undefined): string {
  if (/mono|courier/i.test(name ?? "")) return "monospace";
  if (/sans|arial|helvetica/i.test(name ?? "")) return "sans-serif";
  return "serif";
}

/** Selectable text follows the raster frame at every fitted or zoomed size; the raster supplies visible ink. */
export function SourcePageTextLayer({ page }: { page: SourcePageText }) {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const spans = element.querySelectorAll<HTMLElement>("[data-source-text-run]");
      page.runs.forEach((run, index) => {
        const span = spans[index];
        if (!span) return;
        span.style.fontSize = `${height * run.fontSize}px`;
        const glyph = span.querySelector<HTMLElement>("[data-source-text-glyph]");
        const measured = glyph?.offsetWidth ?? 0;
        const scale = measured > 0 ? run.width * width / measured : 1;
        span.style.transform = `rotate(${run.angle}deg) scaleX(${scale})`;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    let active = true;
    document.fonts?.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer.disconnect(); };
  }, [page]);
  return <div ref={layer} className="source-page-text" data-source-page-text role="document" aria-label="Selectable original page text">
    {page.runs.map((run, index) => <span key={index} data-source-text-run dir={run.dir} style={{ left: `${run.x * 100}%`, top: `${run.y * 100}%`, fontFamily: family(run.fontFamily), transform: `rotate(${run.angle}deg)` }}>
      <span data-source-text-glyph>{run.text}</span><span className="source-page-text-separator">{separator(run, page.runs[index + 1], page)}</span>
    </span>)}
  </div>;
}
