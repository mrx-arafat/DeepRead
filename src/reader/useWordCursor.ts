import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { inPages, showOnPage } from "./paging.ts";
import { setHighlight, stepWord, type Span } from "./textRanges.ts";

export type WordCursor = {
  /** The one block in this chapter that Tab stops on: the text is a single stop, the arrows move inside it. */
  tabbable: string | undefined;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Remember a word the reader tapped, so the keyboard carries on from there. */
  placeAt: (word: Range) => void;
};

type At = { block: HTMLElement; word: Span };

function textOf(block: HTMLElement): Text | null {
  return block.firstChild instanceof Text ? block.firstChild : null;
}

function rangeOf(text: Text, span: Span): Range {
  const range = document.createRange();
  range.setStart(text, span.start);
  range.setEnd(text, span.end);
  return range;
}

/** Scroll just enough to show `range` clear of the sticky top bar and the bottom edge; in pages, turn to its page. */
function reveal(range: Range) {
  const rect = range.getBoundingClientRect();
  if (inPages()) return showOnPage(rect);
  const top = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  if (rect.top < top) window.scrollBy(0, rect.top - top);
  else if (rect.bottom > window.innerHeight - 24) window.scrollBy(0, rect.bottom - window.innerHeight + 96);
}

/**
 * Reading by keyboard: Tab reaches the text, Up and Down move between paragraphs, Left and Right move a word
 * cursor, Shift with Left or Right selects word by word, and Enter asks about the word or the selection.
 */
export function useWordCursor(firstBlockId: string | undefined, onAsk: (word: Range) => void): WordCursor {
  const [entry, setEntry] = useState<string | null>(null);
  // Kept in refs: moving the cursor must not re-render the chapter.
  const at = useRef<At | null>(null);
  const anchor = useRef<Span | null>(null);
  // The cursor shows once the reader uses the keyboard; until then Up and Down scroll the page as usual.
  const shown = useRef(false);

  function paint() {
    const text = at.current && textOf(at.current.block);
    setHighlight("dr-cursor", text && at.current ? rangeOf(text, at.current.word) : null);
    shown.current = true;
  }

  function put(block: HTMLElement, word: Span) {
    at.current = { block, word };
    paint();
    const text = textOf(block);
    if (text) reveal(rangeOf(text, word));
  }

  function select(text: Text, from: Span, to: Span) {
    window.getSelection()?.setBaseAndExtent(text, Math.min(from.start, to.start), text, Math.max(from.end, to.end));
  }

  function dropSelection() {
    if (anchor.current) window.getSelection()?.removeAllRanges();
    anchor.current = null;
  }

  // `end` picks where the cursor lands: the first word (1) or, when stepping back past a paragraph start, the last (-1).
  function moveBlock(block: HTMLElement, step: 1 | -1, end: 1 | -1, container: HTMLElement) {
    const all = [...container.querySelectorAll<HTMLElement>("[data-block]")];
    const target = all[all.indexOf(block) + step];
    const text = target && textOf(target);
    if (!target || !text) return;
    dropSelection();
    target.focus();
    const word = stepWord(text.data, null, end);
    if (word) put(target, word);
  }

  function onFocus(event: FocusEvent<HTMLElement>) {
    const block = event.target;
    const text = textOf(block);
    if (!block.dataset.block || !text) return;
    setEntry(block.dataset.block);
    if (at.current?.block !== block) {
      anchor.current = null;
      const first = stepWord(text.data, null, 1);
      at.current = first ? { block, word: first } : null;
    }
    // Only a keyboard reader needs to see where the cursor is.
    if (block.matches(":focus-visible")) paint();
  }

  function onBlur(event: FocusEvent<HTMLElement>) {
    if (!event.target.dataset.block) return;
    setHighlight("dr-cursor", null);
    shown.current = false;
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const block = event.target as HTMLElement;
    const text = textOf(block);
    if (!block.dataset.block || !text || event.altKey || event.ctrlKey || event.metaKey) return;
    const current = at.current?.block === block ? at.current.word : null;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = stepWord(text.data, current, step);
      if (!next) {
        // Past the last word: carry on in the next paragraph, the way a caret would.
        if (!event.shiftKey) moveBlock(block, step, step, event.currentTarget);
        return;
      }
      if (event.shiftKey) {
        anchor.current ??= current ?? next;
        select(text, anchor.current, next);
      } else {
        dropSelection();
      }
      put(block, next);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.shiftKey && shown.current) {
      event.preventDefault();
      moveBlock(block, event.key === "ArrowDown" ? 1 : -1, 1, event.currentTarget);
    } else if (event.key === "Enter" || event.key === "ContextMenu") {
      event.preventDefault();
      const word = current ?? stepWord(text.data, null, 1);
      if (word) onAsk(rangeOf(text, word));
    }
  }

  function placeAt(word: Range) {
    const block = word.startContainer.parentElement;
    if (!block?.dataset.block) return;
    anchor.current = null;
    at.current = { block, word: { start: word.startOffset, end: word.endOffset } };
  }

  return { tabbable: entry ?? firstBlockId, onFocus, onBlur, onKeyDown, placeAt };
}
