import { useEffect, useState } from "react";
import { HIGHLIGHT_COLORS } from "../../shared/types.ts";
import type { Chapter, HighlightNote, Note, QuestionNote } from "../../shared/types.ts";
import { readableBlocks } from "./book.ts";
import { highlightMark, quoteSpans, rangeInBlock, setHighlight } from "./textRanges.ts";

/** The note a pointer or focus event is about: the card it happened in, if any. */
function noteOf(target: EventTarget | null): string | null {
  return target instanceof Element ? (target.closest<HTMLElement>("[data-note]")?.dataset.note ?? null) : null;
}

/** The ranges a note's passage covers in the chapters on the page: none while its chapter is not there. */
function rangesOf(note: Note, chapters: Chapter[]): Range[] {
  const chapter = chapters.find((item) => item.id === note.chapterId);
  const offset = note.mode === "highlight" ? note.offset : undefined;
  const spans = chapter ? quoteSpans(readableBlocks(chapter), note.blockId, note.quote, offset) : [];
  return spans.map(({ blockId, span }) => rangeInBlock(blockId, span)).filter((range) => range !== null);
}

/**
 * Keeps the passage each note explains marked in the text while the note exists, so the reader can see which
 * words a card belongs to. Pointing at a card, or moving focus into it, marks its own passage more strongly.
 * Highlights are painted in their own colours, each under a mark of its own.
 */
export function useNoteMarks(notes: QuestionNote[], highlights: HighlightNote[], chapters: Chapter[]): void {
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    const onOver = (event: PointerEvent) => setHovered(noteOf(event.target));
    const onOut = (event: PointerEvent) => setHovered(noteOf(event.relatedTarget));
    const onFocusIn = (event: FocusEvent) => setFocused(noteOf(event.target));
    const onFocusOut = (event: FocusEvent) => setFocused(noteOf(event.relatedTarget));
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  useEffect(() => {
    const marks = notes.map((note) => ({ id: note.id, ranges: rangesOf(note, chapters) }));
    const active = hovered ?? focused;
    setHighlight("dr-note", marks.flatMap((mark) => mark.ranges));
    setHighlight("dr-note-active", marks.find((mark) => mark.id === active)?.ranges ?? null);
    return () => {
      setHighlight("dr-note", null);
      setHighlight("dr-note-active", null);
    };
  }, [notes, chapters, hovered, focused]);

  // Apart from the note marks, so pointing at a card does not paint every highlight again. Painted again whenever a
  // chapter comes onto the page or goes, so a highlight in it shows.
  useEffect(() => {
    for (const color of HIGHLIGHT_COLORS) {
      const ranges = highlights.filter((highlight) => highlight.color === color).flatMap((highlight) => rangesOf(highlight, chapters));
      setHighlight(highlightMark(color), ranges);
    }
    return () => {
      for (const color of HIGHLIGHT_COLORS) setHighlight(highlightMark(color), null);
    };
  }, [highlights, chapters]);
}
