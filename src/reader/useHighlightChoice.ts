import { useMemo } from "react";
import type { Chapter } from "../../shared/types.ts";
import { setPrefs, usePrefs } from "../prefs.ts";
import { readableBlocks } from "./book.ts";
import type { HighlightChoice } from "./HighlightGroup.tsx";
import { highlightTarget } from "./highlights.ts";
import type { Notes } from "./useNotes.ts";
import type { Lookup } from "./WordPopover.tsx";

/** How far into its paragraph's text a range starts. Selected from the paragraph's very edge, it starts at the element. */
function startInBlock(range: Range): number {
  const { startContainer, startOffset } = range;
  if (startContainer instanceof Text) return startOffset;
  return startOffset === 0 ? 0 : (startContainer.textContent?.length ?? 0);
}

/**
 * What the highlighter offers for a selection (the selection bar) or a word or term looked up (the word card): the
 * same words, the same decision and the same changes for both. Either highlights in the colour picked, or changes or
 * removes the highlight the words lie inside, then calls `onDone` to close what offered it. Undefined while there is
 * nothing to highlight, or its words cannot be found in the text to paint.
 */
export function useHighlightChoice(
  lookup: Lookup | null,
  chapters: Chapter[],
  notes: Pick<Notes, "highlights" | "addHighlight" | "removeNote">,
  onDone: () => void,
): HighlightChoice | undefined {
  const lastColor = usePrefs().highlight;
  const { highlights, addHighlight, removeNote } = notes;
  const target = useMemo(() => {
    const chapter = lookup && chapters.find((item) => item.id === lookup.chapterId);
    if (!lookup || !chapter) return null;
    return highlightTarget(readableBlocks(chapter), highlights, { blockId: lookup.blockId, quote: lookup.text, from: startInBlock(lookup.range) });
  }, [lookup, chapters, highlights]);

  if (!lookup || !target) return undefined;
  const { around } = target;
  return {
    color: around?.color ?? lastColor,
    editing: around !== null,
    onPick(color) {
      setPrefs({ highlight: color });
      if (!around) {
        addHighlight({ chapterId: lookup.chapterId, blockId: target.blockId, quote: target.quote, offset: target.offset, color });
      } else if (around.color !== color) {
        // The same words again: it replaces the highlight they lie in (shared/notes.ts), in the new colour.
        addHighlight({ chapterId: around.chapterId, blockId: around.blockId, quote: around.quote, offset: around.offset, color });
      }
      onDone();
    },
    onRemove() {
      if (around) removeNote(around.id);
      onDone();
    },
  };
}
