import { memo, type MouseEvent } from "react";
import type { Block, LangCode } from "../../shared/types.ts";
import { NoteCard, type Note } from "./NoteCard.tsx";
import { blockOf, termSpan, wordRangeAtPoint } from "./textRanges.ts";
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

const HEADING_TAGS = { 1: "h2", 2: "h3", 3: "h4" } as const;

/** One block of book text. Must stay a single text node: word and sentence ranges rely on it. */
const BlockText = memo(function BlockText({ block }: { block: Block }) {
  if (block.type === "heading") {
    const Tag = HEADING_TAGS[block.level ?? 1];
    return <Tag data-block={block.id}>{block.text}</Tag>;
  }
  return <p data-block={block.id}>{block.text}</p>;
});

/** The text of one chapter. A tap on a word looks it up; a selection offers explanations. */
export function ChapterText({ blocks, notes, bookId, chapterId, lang, actions }: Props) {
  const { onWord, onSelect, onDismiss, onCloseNote } = actions;

  function handleMouseUp(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !blockOf(event.target as Node)) return;
    const { clientX, clientY } = event;
    const container = event.currentTarget;
    // Wait a tick: a plain click only clears an old selection after mouseup.
    setTimeout(() => {
      const selection = window.getSelection();
      const selected = selection?.toString().trim() ?? "";
      if (selection && !selection.isCollapsed && selected) {
        const range = selection.getRangeAt(0).cloneRange();
        const block = blockOf(range.startContainer);
        // A selection that starts in another chapter belongs to that chapter, not this one.
        if (!block?.dataset.block || !container.contains(block)) return;
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
          onSelect({ range, text: selected.slice(0, 1500), chapterId, blockId });
        }
        return;
      }
      const range = wordRangeAtPoint(clientX, clientY);
      const block = range && blockOf(range.startContainer);
      if (range && block?.dataset.block) onWord({ range, text: range.toString(), chapterId, blockId: block.dataset.block });
      else onDismiss();
    }, 0);
  }

  return (
    <div className="chapter-text" onMouseUp={handleMouseUp}>
      {blocks.map((block) => (
        <div className="row" key={block.id}>
          {notes
            .filter((note) => note.blockId === block.id)
            .map((note) => (
              <NoteCard key={note.id} note={note} bookId={bookId} lang={lang} onClose={onCloseNote} />
            ))}
          <BlockText block={block} />
        </div>
      ))}
    </div>
  );
}
