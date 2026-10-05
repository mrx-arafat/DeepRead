// Pages: the book's one scroll, moved a screen at a time so that every page starts on a whole line and no line is
// ever shown cut. The page is the part of the window between the top margin and the strip over its bottom edge.

export type Box = { top: number; bottom: number };

/** The pieces of text that share a line (a word in another font, a highlighted span) as one line, top to bottom. */
export function mergeLines(pieces: Box[]): Box[] {
  const lines: Box[] = [];
  for (const piece of [...pieces].sort((a, b) => a.top - b.top)) {
    const last = lines.at(-1);
    const overlap = last ? Math.min(last.bottom, piece.bottom) - Math.max(last.top, piece.top) : 0;
    if (last && overlap > 0.5 * Math.min(last.bottom - last.top, piece.bottom - piece.top)) {
      last.top = Math.min(last.top, piece.top);
      last.bottom = Math.max(last.bottom, piece.bottom);
    } else {
      lines.push({ ...piece });
    }
  }
  return lines;
}

/**
 * Where the page that starts at `top` ends: at the first line that does not fit whole above `bottom`, which the
 * strip then hides. At `bottom` when every line fits, or when that line starts at the top (taller than a page).
 * Sooner where a chapter starts (`breaks`), so each chapter opens on a page of its own, as in a printed book.
 */
export function pageEnd(lines: Box[], top: number, bottom: number, breaks: number[] = []): number {
  const cut = lines.find((line) => line.bottom > bottom + 0.5);
  const end = cut && cut.top > top + 0.5 ? Math.min(cut.top, bottom) : bottom;
  return Math.min(end, ...breaks.filter((at) => at > top + 0.5));
}

/** How far to move a page whose top edge cuts a line, so that line starts the page (negative: back up). */
export function snapShift(lines: Box[], top: number): number {
  const cut = lines.find((line) => line.top < top - 0.5 && line.bottom > top + 0.5);
  return cut ? cut.top - top : 0;
}

/**
 * Where the page before the one starting at `current` starts, all in document coordinates: on the first whole line
 * that leaves room to reach `current`, so that page ends where this one begins. A chapter start (`breaks`) within
 * that reach starts it instead, at the chapter's top edge: no page runs across one, and a chapter's first page
 * looks the same turned to from either side.
 */
export function previousPageTop(lines: Box[], current: number, top: number, bottom: number, breaks: number[] = []): number {
  const earliest = current - (bottom - top);
  const chapters = breaks.filter((at) => at >= earliest - 0.5 && at < current - 0.5);
  if (chapters.length > 0) return Math.max(0, ...chapters);
  if (earliest <= 0) return 0;
  return lines.find((line) => line.top >= earliest - 0.5 && line.top < current)?.top ?? earliest;
}

/** Whole pages after this one, up to `contentBottom`, for a page that ends at `end`. */
export function pagesLeft(contentBottom: number, end: number, top: number, bottom: number): number {
  return contentBottom <= end + 0.5 ? 0 : Math.ceil((contentBottom - end) / (bottom - top));
}

// What follows reads the page as it is laid out.

/** The reader is in a book, turning pages. */
export function inPages(): boolean {
  return document.documentElement.dataset.layout === "pages" && document.querySelector(".reader") !== null;
}

/** Where the page is in the window: under the top margin, down to the footer or the player, whichever is higher. */
export function pageFrame(): Box {
  // The stylesheet puts the page's top margin in scroll-padding-top, so a jump to a chapter lands on it too.
  const top = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  const below = document.querySelector(".listen-bar, .reading-footer")?.getBoundingClientRect().top ?? window.innerHeight;
  // A little paper between the last line and the footer, as on a printed page.
  return { top, bottom: Math.min(window.innerHeight, below) - 10 };
}

/**
 * The lines of the book's column that reach into `from` to `to` (window coordinates): every line of text, in
 * paragraphs, headings and the boxes between them, but not the notes beside the column on a wide screen.
 */
export function linesIn(from: number, to: number): Box[] {
  const page = document.querySelector("main.page");
  const column = page?.querySelector(".chapter")?.getBoundingClientRect();
  if (!page || !column) return [];
  const pieces: Box[] = [];
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element) {
        const box = node.getBoundingClientRect();
        // An element with no box of its own (display: contents) may still hold laid-out text.
        if (box.width === 0 && box.height === 0) return NodeFilter.FILTER_SKIP;
        const outside = box.bottom < from || box.top > to || box.right <= column.left || box.left >= column.right;
        return outside ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      // A few px is text hidden for screen readers only, not a line anyone sees.
      if (rect.height >= 4 && rect.bottom >= from && rect.top <= to) pieces.push({ top: rect.top, bottom: rect.bottom });
    }
  }
  return mergeLines(pieces);
}

/** Where each chapter after the first on the page starts, in px from the window top. */
export function chapterStarts(): number[] {
  return [...document.querySelectorAll("[data-chapter]")].slice(1).map((chapter) => chapter.getBoundingClientRect().top);
}

// Where the page on screen ends, as the strip over its bottom edge shows it; kept by usePages.
let shownEnd: number | null = null;

export function setShownEnd(end: number | null): void {
  shownEnd = end;
}

/**
 * Turns to the page that shows `box` (window coordinates), with its first line at the top, unless it is already
 * all on the page. Returns whether it turned. For whatever follows the reader's place by itself: the voice reading
 * aloud, the word cursor.
 */
export function showOnPage(box: Box): boolean {
  const frame = pageFrame();
  if (box.top >= frame.top - 0.5 && box.bottom <= (shownEnd ?? frame.bottom) + 0.5) return false;
  window.scrollTo({ top: window.scrollY + box.top - frame.top, behavior: "instant" });
  return true;
}
