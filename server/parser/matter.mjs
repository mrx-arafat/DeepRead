// Front and back matter: what surrounds the book's own text. Title pages, copyright and contents come before it;
// notes, index and licences after it. They stay in the book, but the reader opens past the front matter,
// the book ends before the back matter, and neither counts as reading.

const FRONT_MATTER_RE =
  /^(?:cover( page| image)?|front cover|title( page)?|half[- ]title|copyright( page| notice)?|dedication|epigraph|contents|table of contents|praise( for.*)?|also by.*|other books.*|books by.*|about the publishers?|newsletter.*|frontispiece|imprint|map|maps|acknowledge?ments|about the authors?|list of (?:illustrations|figures|tables|maps|plates)|abbreviations)$/i;
const BACK_MATTER_RE =
  /^(?:notes|endnotes|notes on sources|sources|bibliograph.*|references|works cited|further reading|recommended reading|suggested reading|glossary|index|acknowledge?ments|about the (?:authors?|translators?)|appendix\b.*|appendices|copyright( page| notice)?|credits|permissions|colophon|also by.*|other books.*|books by.*|newsletter.*|praise( for.*)?|project gutenberg licen[cs]e)$/i;
const GUTENBERG_START_RE = /^\*{3}\s*start of (?:the|this) project gutenberg/i;
const GUTENBERG_END_RE = /^\*{3}\s*end of (?:the|this) project gutenberg/i;

/** @typedef {import("./matter.d.mts").MatterSection} Section */

const bare = (title) => title.trim().replace(/[\s.:]+$/, "");
const words = (text) => text.split(/\s+/).filter(Boolean).length;

/** An untitled opening can be a chapter the outline or headings missed: real paragraphs, not a title page. */
function readsLikeChapter(section) {
  const counts = section.blocks.map((b) => words(b.text)).sort((a, b) => a - b);
  const prose = counts.filter((n) => n >= 40).reduce((sum, n) => sum + n, 0);
  return prose >= 1000 && (counts[counts.length >> 1] ?? 0) >= 25;
}

/**
 * Project Gutenberg wraps every book in its own header and licence, marked by "*** START OF ..." and "*** END OF ...".
 * Wherever the chapters fell, everything up to the first marker is front matter and everything from the second is back.
 * @param {Section[]} list
 */
function cutGutenberg(list) {
  const findMarker = (re) => {
    for (const [si, section] of list.entries()) {
      const bi = section.blocks.findIndex((b) => re.test(b.text));
      if (bi >= 0) return { si, bi };
    }
    return null;
  };
  const end = findMarker(GUTENBERG_END_RE);
  if (end) {
    const cut = list[end.si];
    const marker = cut.blocks[end.bi];
    const licence = { title: "Project Gutenberg License", kind: "back", startPage: marker.page, y: marker.y, blocks: [...cut.blocks.slice(end.bi), ...list.slice(end.si + 1).flatMap((s) => s.blocks)] };
    cut.blocks = cut.blocks.slice(0, end.bi);
    list = [...list.slice(0, end.si), ...(cut.blocks.length ? [cut] : []), licence];
  }
  const start = findMarker(GUTENBERG_START_RE);
  if (start) {
    const cut = list[start.si];
    const header = { title: "Front Matter", kind: "front", startPage: list[0].startPage, y: null, blocks: [...list.slice(0, start.si).flatMap((s) => s.blocks), ...cut.blocks.slice(0, start.bi + 1)] };
    cut.blocks = cut.blocks.slice(start.bi + 1);
    list = [header, ...(cut.blocks.length ? [cut] : []), ...list.slice(start.si + 1)];
  }
  return list;
}

/**
 * Cuts Project Gutenberg's header and licence off the book, marks every section front, body or back matter,
 * and folds the leading front matter into one section. Front matter is a leading run, back matter a trailing one,
 * so a "Notes" section between two chapters stays part of the read. At least one section is always body.
 * @param {Section[]} sections
 * @returns {Section[]}
 */
export function separateMatter(sections) {
  const list = cutGutenberg(sections);
  const isFront = (s) => s.kind === "front" || FRONT_MATTER_RE.test(bare(s.title)) || (s.untitled === true && !readsLikeChapter(s));
  const isBack = (s) => s.kind === "back" || BACK_MATTER_RE.test(bare(s.title));
  let first = 0;
  while (first < list.length - 1 && isFront(list[first])) first++;
  let last = list.length - 1;
  while (last > first && isBack(list[last])) last--;
  list.forEach((s, i) => (s.kind = i < first ? "front" : i > last ? "back" : "body"));
  if (first < 2) return list;
  const front = { title: "Front Matter", kind: "front", startPage: list[0].startPage, y: null, blocks: list.slice(0, first).flatMap((s) => s.blocks) };
  return [front, ...list.slice(first)];
}
