import { memo } from "react";
import type { Block, LangCode } from "../../shared/types.ts";
import { NoteCard, type Note } from "./NoteCard.tsx";
import { blockOf, wordRangeAtPoint } from "./textRanges.ts";
import type { Lookup } from "./WordPopover.tsx";

type Props = {
  blocks: Block[];
  notes: Note[];
  bookId: string;
  chapterId: string;
  lang: LangCode;
  onWord: (lookup: Lookup) => void;
  onSelect: (lookup: Lookup) => void;
  onDismiss: () => void;
  onCloseNote: (id: string) => void;
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

/** The chapter itself. A tap on a word looks it up; a selection offers explanations. */
export function ChapterText({ blocks, notes, bookId, chapterId, lang, onWord, onSelect, onDismiss, onCloseNote }: Props) {
  function handleMouseUp(event: React.MouseEvent) {
    if (event.button !== 0 || !blockOf(event.target as Node)) return;
    const { clientX, clientY } = event;
    // Wait a tick: a plain click only clears an old selection after mouseup.
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      if (selection && !selection.isCollapsed && text) {
        const range = selection.getRangeAt(0).cloneRange();
        const block = blockOf(range.startContainer);
        if (!block?.dataset.block) return;
        const lookup = { range, text: text.slice(0, 1500), blockId: block.dataset.block };
        if (/\s/.test(text)) onSelect(lookup);
        else onWord(lookup);
        return;
      }
      const range = wordRangeAtPoint(clientX, clientY);
      const block = range && blockOf(range.startContainer);
      if (range && block?.dataset.block) onWord({ range, text: range.toString(), blockId: block.dataset.block });
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
              <NoteCard key={note.id} note={note} bookId={bookId} chapterId={chapterId} lang={lang} onClose={onCloseNote} />
            ))}
          <BlockText block={block} />
        </div>
      ))}
    </div>
  );
}
