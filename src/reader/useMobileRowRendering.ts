import { useLayoutEffect, type RefObject } from "react";
import type { Block, LangCode, QuestionNote } from "../../shared/types.ts";
import { indexAtLine } from "./book.ts";

const TYPOGRAPHY_ATTRIBUTES = ["data-font", "data-spacing", "data-margins", "data-align", "data-layout"];

/** Synchronous typography changes must release old placeholders before measuring their new anchor. */
export function releaseMobileRowRendering(scope: ParentNode = document): void {
  for (const chunk of scope.querySelectorAll<HTMLElement>("[data-mobile-rendering]")) {
    chunk.removeAttribute("data-mobile-rendering");
    chunk.style.removeProperty("--text-chunk-size");
  }
}

/** Keep all source text in the DOM, but let the browser skip distant, unchanged text chunks. */
export function manageMobileRowRendering(container: HTMLElement): () => void {
  if (!CSS.supports("content-visibility", "auto") || !CSS.supports("contain-intrinsic-block-size", "1px")) return () => {};
  const root = document.documentElement;
  // At this breakpoint rows become blocks and note cards float across paragraph boundaries.
  const desktop = window.matchMedia("(min-width: 72rem)");
  const chunks = Array.from(container.querySelectorAll<HTMLElement>(":scope > .text-chunk"));
  let alive = true;
  let width = container.getBoundingClientRect().width;
  const settings = () => JSON.stringify([
    ...TYPOGRAPHY_ATTRIBUTES.map((attribute) => root.getAttribute(attribute)),
    root.style.getPropertyValue("--book-size"),
  ]);
  let previousSettings = settings();

  const clear = () => {
    for (const chunk of chunks) {
      chunk.removeAttribute("data-mobile-rendering");
      chunk.style.removeProperty("--text-chunk-size");
    }
  };
  const refresh = () => {
    if (!alive) return;
    // Never measure a skipped subtree or reuse a height from a different font, width or translation.
    clear();
    if (desktop.matches || root.dataset.layout === "pages") return;
    // Notes stream their answers. Figures with declared CSS dimensions reserve their complete
    // aspect ratio before decoding; legacy/invalid-size figures still need ordinary layout.
    const measured = chunks.filter((chunk) => !chunk.querySelector(".note, .book-figure:not([data-fixed-size])"))
      .map((chunk) => ({ chunk, height: chunk.getBoundingClientRect().height }));
    // All layout reads precede writes, and placeholders use actual sizes rather than estimates.
    for (const { chunk, height } of measured) {
      if (!Number.isFinite(height) || height <= 0) continue;
      chunk.style.setProperty("--text-chunk-size", `${height}px`);
      chunk.setAttribute("data-mobile-rendering", "");
    }
  };
  refresh();

  const refreshKeepingRow = () => {
    if (!alive) return;
    if (desktop.matches || root.dataset.layout === "pages") { refresh(); return; }
    // A newly loaded translation font can change distant rows while their old placeholders
    // still occupy the page. Keep the visible row when those placeholders are invalidated.
    // Geometry works even when a selection card or settings panel covers the eye line.
    // Wrapper rects retain their sizes without forcing skipped text descendants to render.
    const anchors = document.querySelectorAll<HTMLElement>(".chapter-head, .chapter-text > .text-chunk");
    const at = indexAtLine(anchors.length, (index) => anchors[index]!.getBoundingClientRect().bottom, 96);
    const section = anchors[Math.min(at, anchors.length - 1)];
    // Read descendant geometry only inside the chunk at the eye line, never distant text.
    const visibleRows = section?.querySelectorAll<HTMLElement>(":scope > .row");
    const rowAt = visibleRows ? indexAtLine(visibleRows.length, (index) => visibleRows[index]!.getBoundingClientRect().bottom, 96) : 0;
    const anchor = visibleRows?.[Math.min(rowAt, visibleRows.length - 1)] ?? section;
    const before = anchor?.getBoundingClientRect().top;
    const previousAnchor = root.style.overflowAnchor;
    root.style.overflowAnchor = "none";
    refresh();
    if (anchor?.isConnected && before !== undefined) window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: "instant" });
    if (previousAnchor !== "none") requestAnimationFrame(() => {
      if (root.style.overflowAnchor === "none") root.style.overflowAnchor = previousAnchor;
    });
  };

  const resized = new ResizeObserver(() => {
    const nextWidth = container.getBoundingClientRect().width;
    if (nextWidth === width) return;
    width = nextWidth;
    refreshKeepingRow();
  });
  resized.observe(container);
  const changed = new MutationObserver(() => {
    const nextSettings = settings();
    if (nextSettings === previousSettings) return;
    previousSettings = nextSettings;
    refreshKeepingRow();
  });
  changed.observe(root, { attributes: true, attributeFilter: [...TYPOGRAPHY_ATTRIBUTES, "style"] });
  desktop.addEventListener("change", refreshKeepingRow);
  const fonts = document.fonts;
  fonts?.addEventListener("loadingdone", refreshKeepingRow);

  return () => {
    alive = false;
    resized.disconnect();
    changed.disconnect();
    desktop.removeEventListener("change", refreshKeepingRow);
    fonts?.removeEventListener("loadingdone", refreshKeepingRow);
    clear();
  };
}

export function useMobileRowRendering(
  container: RefObject<HTMLDivElement | null>,
  blocks: Block[],
  notes: QuestionNote[],
  translated: Record<string, string> | undefined,
  lang: LangCode | undefined,
): void {
  // Cursor/selection renders do not invalidate row sizes; changes to their contents do.
  useLayoutEffect(() => {
    if (container.current) return manageMobileRowRendering(container.current);
  }, [container, blocks, notes, translated, lang]);
}
