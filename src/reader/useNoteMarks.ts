import { useEffect, useState } from "react";
import type { Chapter, Note } from "../../shared/types.ts";
import { readableBlocks } from "./book.ts";
import { quoteSpans, rangeInBlock, setHighlight } from "./textRanges.ts";

/** The note a pointer or focus event is about: the card it happened in, if any. */
function noteOf(target: EventTarget | null): string | null {
  return target instanceof Element ? (target.closest<HTMLElement>("[data-note]")?.dataset.note ?? null) : null;
}

/**
 * Keeps the passage each note explains marked in the text while the note exists, so the reader can see which
 * words a card belongs to. Pointing at a card, or moving focus into it, marks its own passage more strongly.
 */
export function useNoteMarks(notes: Note[], chapters: Chapter[]): void {
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
    const marks = notes.map((note) => {
      const chapter = chapters.find((item) => item.id === note.chapterId);
      const spans = chapter ? quoteSpans(readableBlocks(chapter), note.blockId, note.quote) : [];
      const ranges = spans.map(({ blockId, span }) => rangeInBlock(blockId, span)).filter((range) => range !== null);
      return { id: note.id, ranges };
    });
    const active = hovered ?? focused;
    setHighlight("dr-note", marks.flatMap((mark) => mark.ranges));
    setHighlight("dr-note-active", marks.find((mark) => mark.id === active)?.ranges ?? null);
    return () => {
      setHighlight("dr-note", null);
      setHighlight("dr-note-active", null);
    };
  }, [notes, chapters, hovered, focused]);
}
