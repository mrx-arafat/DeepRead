import type { Chapter, Note, ReadingProgress } from "../../shared/types.ts";

interface ResumeText {
  state: "ready" | "start" | "missing";
  excerpt: string;
  highlight: { quote: string; page: number; blockId: string; offset: number } | null;
}

const EXCERPT_LIMIT = 600;
const HIGHLIGHT_LIMIT = 280;
const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function prefix(text: string, boundary: number): string {
  let end = 0;
  for (const part of characters.segment(text)) {
    const next = part.index + part.segment.length;
    if (next > boundary) break;
    end = next;
  }
  return text.slice(0, end);
}

function suffix(text: string, limit: number): string {
  const boundary = Math.max(0, text.length - limit);
  for (const part of characters.segment(text)) {
    if (part.index >= boundary) return text.slice(part.index);
  }
  return "";
}

/** Resolve a bounded reminder using only text and complete highlights before the saved position. */
export function resumeText(chapter: Chapter, progress: ReadingProgress | null, notes: readonly Note[]): ResumeText {
  const empty = { excerpt: "", highlight: null };
  if (!progress) return { state: "start", ...empty };
  const at = chapter.blocks.findIndex((block) => block.id === progress.blockId);
  const block = chapter.blocks[at];
  const savedOffset = progress.offset ?? 0;
  if (chapter.id !== progress.chapterId || !block || !Number.isFinite(savedOffset)) return { state: "missing", ...empty };
  const offset = Math.max(0, Math.min(block.text.length, Math.floor(savedOffset)));
  let preceding = prefix(block.text, offset);
  for (let i = at - 1; i >= 0 && preceding.length < EXCERPT_LIMIT; i--) {
    preceding = `${chapter.blocks[i]!.text.slice(-EXCERPT_LIMIT)}\n\n${preceding}`;
  }
  let excerpt = preceding;
  if (preceding.length > EXCERPT_LIMIT) {
    excerpt = suffix(preceding, EXCERPT_LIMIT - 3);
    // Prefer a complete word without dropping most of a passage that has little whitespace.
    const space = excerpt.search(/\s/);
    if (space >= 0 && space < EXCERPT_LIMIT / 2) excerpt = excerpt.slice(space + 1);
    excerpt = `...${excerpt}`;
  }
  excerpt = excerpt.trim();

  const positions = new Map(chapter.blocks.slice(0, at + 1).map((source, index) => [source.id, index]));
  let highlight: ResumeText["highlight"] = null;
  let nearestBlock = -1;
  let nearestOffset = -1;
  for (const note of notes) {
    if (note.mode !== "highlight" || note.chapterId !== chapter.id || !note.quote.trim()) continue;
    const index = positions.get(note.blockId);
    const source = index === undefined ? undefined : chapter.blocks[index];
    if (!source || index === undefined || !Number.isInteger(note.offset) || note.offset < 0) continue;
    const end = note.offset + note.quote.length;
    if (end > (index === at ? offset : source.text.length) || source.text.slice(note.offset, end) !== note.quote) continue;
    if (index < nearestBlock || (index === nearestBlock && note.offset <= nearestOffset)) continue;
    nearestBlock = index;
    nearestOffset = note.offset;
    const quote = prefix(note.quote, HIGHLIGHT_LIMIT).trim();
    highlight = { quote: note.quote.length > HIGHLIGHT_LIMIT ? `${quote}...` : quote, page: source.page, blockId: note.blockId, offset: note.offset };
  }
  return { state: excerpt || highlight ? "ready" : "start", excerpt, highlight };
}
