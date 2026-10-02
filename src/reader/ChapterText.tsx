import { memo, useRef, type MouseEvent } from "react";
import type { Block, LangCode } from "../../shared/types.ts";
import { NoteCard, type Note } from "./NoteCard.tsx";
import { blockOf, termSpan, wordRangeAtPoint } from "./textRanges.ts";
import { useWordCursor } from "./useWordCursor.ts";
import type { Lookup } from "./WordPopover.tsx";

/** What the reader can do with the text. Shared by every chapter on the page, so keep the functions stable. */
export type TextActions = {
  onWord: (lookup: Lookup) => void;
  onSelect: (lookup: Lookup) => void;
  onDismiss: () => void;
  onCloseNote: (id: string) => void;
};

type Props = {
  blocks: Block[];
  /** Notes for the whole book; each shows beside its own block. */
  notes: Note[];
  bookId: string;
  chapterId: string;
  lang: LangCode;
  actions: TextActions;
};

// The book is the page's h1 and each chapter title an h2, so headings inside the text start at h3.
const HEADING_TAGS = { 1: "h3", 2: "h4", 3: "h5" } as const;

/** One block of book text. Must stay a single text node: word and sentence ranges rely on it. */
const BlockText = memo(function BlockText({ block, tabbable }: { block: Block; tabbable: boolean }) {
  const tabIndex = tabbable ? 0 : -1;
  if (block.type === "heading") {
    const Tag = HEADING_TAGS[block.level ?? 1];
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

/** The text of one chapter. A tap on a word looks it up; a selection offers explanations. Both work by keyboard too. */
export function ChapterText({ blocks, notes, bookId, chapterId, lang, actions }: Props) {
  const { onWord, onSelect, onDismiss, onCloseNote } = actions;
  const container = useRef<HTMLDivElement>(null);
  const cursor = useWordCursor(blocks[0]?.id, (word) => ask(word, true));

  /** Ask about the selected text if there is any, else about `word`; with neither, close what is open. */
  function ask(word: Range | null, keyboard: boolean) {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() ?? "";
    if (selection && !selection.isCollapsed && selected) {
      const range = selection.getRangeAt(0).cloneRange();
      const block = blockOf(range.startContainer);
      // A selection that starts in another chapter belongs to that chapter, not this one.
      if (!block?.dataset.block || !container.current?.contains(block)) return;
      const blockId = block.dataset.block;
      // A word or a short term ("a priori") gets its meaning, like a tap; anything longer is a passage to explain.
      const term = range.startContainer === range.endContainer ? termSpan(range.toString()) : null;
      if (term) {
        const from = range.startOffset;
        range.setStart(range.startContainer, from + term.start);
        range.setEnd(range.startContainer, from + term.end);
        selection.removeAllRanges();
        onWord({ range, text: range.toString(), chapterId, blockId });
      } else {
        onSelect({ range, text: selected.slice(0, 1500), chapterId, blockId, keyboard });
      }
      return;
    }
    const block = word && blockOf(word.startContainer);
    if (word && block?.dataset.block) onWord({ range: word, text: word.toString(), chapterId, blockId: block.dataset.block });
    else onDismiss();
  }

  function handleMouseUp(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !blockOf(event.target as Node)) return;
    const { clientX, clientY } = event;
    // Wait a tick: a plain click only clears an old selection after mouseup.
    setTimeout(() => {
      const word = wordRangeAtPoint(clientX, clientY);
      if (word) cursor.placeAt(word);
      ask(word, false);
    }, 0);
  }

  return (
    <div
      ref={container}
      className="chapter-text"
      onMouseUp={handleMouseUp}
      onKeyDown={cursor.onKeyDown}
      onFocus={cursor.onFocus}
      onBlur={cursor.onBlur}
    >
      {blocks.map((block) => (
        <div className="row" key={block.id}>
          {notes
            .filter((note) => note.blockId === block.id)
            .map((note) => (
              <NoteCard key={note.id} note={note} bookId={bookId} lang={lang} onClose={onCloseNote} />
            ))}
          <BlockText block={block} tabbable={block.id === cursor.tabbable} />
        </div>
      ))}
    </div>
  );
}
