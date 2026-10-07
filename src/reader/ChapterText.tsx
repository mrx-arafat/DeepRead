import { memo, useEffect, useEffectEvent, useMemo, useRef, type MouseEvent } from "react";
import type { Block, LangCode, QuestionNote } from "../../shared/types.ts";
import { headingTags } from "./book.ts";
import { NoteCard } from "./NoteCard.tsx";
import { blockOf, termSpan, wordRangeAtPoint } from "./textRanges.ts";
import { useWordCursor } from "./useWordCursor.ts";
import type { Lookup } from "./WordPopover.tsx";

/** What the reader can do with the text. Shared by every chapter on the page, so keep the functions stable. */
export type TextActions = {
  onWord: (lookup: Lookup) => void;
  onSelect: (lookup: Lookup) => void;
  onDismiss: () => void;
  onCloseNote: (id: string, byKeyboard: boolean) => void;
  onSaveAnswer: (note: QuestionNote, answer: string) => void;
};

type Props = {
  blocks: Block[];
  /** Questions for the whole book; each shows beside its own block. */
  notes: QuestionNote[];
  bookId: string;
  chapterId: string;
  actions: TextActions;
  /** The chapter in the reader's language, by block id, while translation is on and has arrived. */
  translation?: { lang: LangCode; blocks: Record<string, string> };
};

// How long a touch selection must rest before the bar offers explanations: the handles may still be moving.
const TOUCH_SETTLE_MS = 400;

/** One block of book text. Must stay a single text node: word and sentence ranges rely on it. */
const BlockText = memo(function BlockText({ block, tag, tabbable }: { block: Block; tag: ReturnType<typeof headingTags>[number]; tabbable: boolean }) {
  const tabIndex = tabbable ? 0 : -1;
  if (block.type === "heading" && tag) {
    const Tag = tag;
    return (
      <Tag data-block={block.id} tabIndex={tabIndex}>
        {block.text}
      </Tag>
    );
  }
  return (
    <p data-block={block.id} tabIndex={tabIndex}>
      {block.text}
    </p>
  );
});

/**
 * The book's own words in a selection, a line per block. A translation or a note card the selection ran over is left
 * out, so what is explained, highlighted or quoted is always the book's text.
 */
function bookText(selection: Selection): string {
  const lines: string[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const part = selection.getRangeAt(index).cloneContents();
    const blocks = part.querySelectorAll("[data-block]");
    // Within one block the copy is a piece of its text alone, with no element around it.
    if (blocks.length === 0) lines.push(part.textContent ?? "");
    else lines.push(...Array.from(blocks, (block) => block.textContent ?? ""));
  }
  return lines.join("\n");
}

/** The text of one chapter. A tap on a word looks it up; a selection offers explanations. Both work by keyboard too. */
export function ChapterText({ blocks, notes, bookId, chapterId, actions, translation }: Props) {
  const { onWord, onSelect, onDismiss, onCloseNote, onSaveAnswer } = actions;
  const container = useRef<HTMLDivElement>(null);
  const cursor = useWordCursor(blocks[0]?.id, (word) => ask(word, "keyboard"));
  const tags = useMemo(() => headingTags(blocks), [blocks]);

  /** Ask about the selected text if there is any, else about `word`; with neither, close what is open. */
  function ask(word: Range | null, via: "mouse" | "keyboard" | "touch") {
    const selection = window.getSelection();
    const selected = selection ? bookText(selection).trim() : "";
    if (selection && !selection.isCollapsed && selected) {
      const range = selection.getRangeAt(0).cloneRange();
      const block = blockOf(range.startContainer);
      // A selection that starts in another chapter belongs to that chapter, not this one.
      if (!block?.dataset.block || !container.current?.contains(block)) return;
      const blockId = block.dataset.block;
      // A word or a short term ("a priori") gets its meaning, like a tap; anything longer is a passage to explain.
      // Not by touch: a long-press selects one word first, and its handles must stay to drag over the rest.
      const term = range.startContainer === range.endContainer && via !== "touch" ? termSpan(range.toString()) : null;
      if (term) {
        const from = range.startOffset;
        range.setStart(range.startContainer, from + term.start);
        range.setEnd(range.startContainer, from + term.end);
        selection.removeAllRanges();
        onWord({ range, text: range.toString(), chapterId, blockId });
      } else {
        onSelect({ range, text: selected.slice(0, 1500), chapterId, blockId, via });
      }
      return;
    }
    const block = word && blockOf(word.startContainer);
    if (word && block?.dataset.block) onWord({ range: word, text: word.toString(), chapterId, blockId: block.dataset.block });
    else onDismiss();
  }

  function handleMouseUp(event: MouseEvent<HTMLDivElement>) {
    // A selection dragged from the book text may end on a translation. One made in a translation alone asks nothing.
    const target = event.target instanceof Element ? event.target : null;
    if (event.button !== 0 || !target?.closest("[data-block], [data-translation-of]")) return;
    const { clientX, clientY } = event;
    // Wait a tick: a plain click only clears an old selection after mouseup.
    setTimeout(() => {
      const word = wordRangeAtPoint(clientX, clientY);
      if (word) cursor.placeAt(word);
      ask(word, "mouse");
    }, 0);
  }

  // A touch selection is made by a long-press and the handles, and neither sends a mouseup. So after a touch,
  // follow the selection itself: hide the bar while the handles move, and offer it again once they rest.
  // Mouse selections stay with mouseup, and keyboard ones with Enter, so neither pops the bar mid-selection.
  const askByTouch = useEffectEvent(() => ask(null, "touch"));
  useEffect(() => {
    let touch = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPointerDown = (event: PointerEvent) => {
      touch = event.pointerType !== "mouse";
    };
    // A key, or a mouseup (a pen, a double-tap), hands the selection back to the keyboard or the mouse.
    const onOtherInput = () => {
      touch = false;
      clearTimeout(timer);
    };
    const onSelectionChange = () => {
      clearTimeout(timer);
      const selection = window.getSelection();
      // A collapsed selection is a tap, which mouseup already handles.
      if (!touch || !selection || selection.isCollapsed || !container.current?.contains(selection.anchorNode)) return;
      onDismiss();
      timer = setTimeout(askByTouch, TOUCH_SETTLE_MS);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onOtherInput, true);
    document.addEventListener("mouseup", onOtherInput, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onOtherInput, true);
      document.removeEventListener("mouseup", onOtherInput, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [onDismiss]);

  return (
    <div
      ref={container}
      className="chapter-text"
      onMouseUp={handleMouseUp}
      onKeyDown={cursor.onKeyDown}
      onFocus={cursor.onFocus}
      onBlur={cursor.onBlur}
    >
      {blocks.map((block, at) => {
        const translated = translation?.blocks[block.id];
        return (
          <div className="row" key={block.id}>
            {notes
              .filter((note) => note.blockId === block.id)
              .map((note) => (
                <NoteCard key={note.id} note={note} bookId={bookId} latest={note.id === notes.at(-1)?.id} onClose={onCloseNote} onSaveAnswer={onSaveAnswer} />
              ))}
            <BlockText block={block} tag={tags[at] ?? null} tabbable={block.id === cursor.tabbable} />
            {/* Beside the block, never inside it: words, sentences, notes, search and the voice all count characters in
                the block's one text node. */}
            {translation && translated ? (
              <p className="block-translation" lang={translation.lang} dir="auto" data-translation-of={block.id}>
                {translated}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
