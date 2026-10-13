import { memo, useEffect, useEffectEvent, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";
import type { Block, LangCode, QuestionNote } from "../../shared/types.ts";
import { headingTags } from "./book.ts";
import { NoteCard } from "./NoteCard.tsx";
import { blockOf, termSpan, wordRangeAtPoint } from "./textRanges.ts";
import { useWordCursor } from "./useWordCursor.ts";
import type { Lookup } from "./WordPopover.tsx";
import "./book-content.css";
import { offsetInBlock, rangeWithin } from "./domText.ts";
import { useMobileRowRendering } from "./useMobileRowRendering.ts";

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
// A few dozen rows share one rendering boundary, avoiding containment work per paragraph.
const TEXT_CHUNK_SIZE = 48;

const FONTS = { serif: "var(--book-face)", "sans-serif": "var(--font-ui)", monospace: "ui-monospace, SFMono-Regular, Consolas, monospace" };

function typography(style: Block["style"]): CSSProperties | undefined {
  if (!style) return undefined;
  return {
    // Prose follows the reader's alignment preference; centered/right source elements keep their placement.
    textAlign: style.align === "center" || style.align === "right" ? style.align : undefined,
    fontFamily: style.fontFamily && FONTS[style.fontFamily],
    fontSize: typeof style.fontSize === "number" && Number.isFinite(style.fontSize) ? `${Math.min(2, Math.max(0.65, style.fontSize))}em` : undefined,
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
  };
}

/** Only text and typed styles are rendered; every segment retains its offsets into the original text. */
function formattedText(block: Block, start = 0, end = block.text.length) {
  const runs = (block.runs ?? []).filter((run) => Number.isInteger(run.start) && Number.isInteger(run.end) && run.start >= 0 && run.end > run.start && run.end <= block.text.length && (
    Boolean(run.bold) !== Boolean(block.style?.bold) || Boolean(run.italic) !== Boolean(block.style?.italic) || run.underline || (run.fontFamily && run.fontFamily !== block.style?.fontFamily)
  ));
  if (!runs.length) return block.text.slice(start, end);
  const boundaries = [...new Set([start, end, ...runs.flatMap((run) => [Math.max(start, run.start), Math.min(end, run.end)]).filter((at) => at > start && at < end)])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((from, index) => {
    const to = boundaries[index + 1]!;
    const active = runs.filter((run) => run.start <= from && run.end >= to);
    const text = block.text.slice(from, to);
    if (!active.length) return text;
    const style: CSSProperties = {};
    if (active.some((run) => run.bold)) style.fontWeight = 700;
    if (active.some((run) => run.italic)) style.fontStyle = "italic";
    if (active.some((run) => run.underline)) style.textDecoration = "underline";
    const family = active.findLast((run) => run.fontFamily)?.fontFamily;
    if (family) style.fontFamily = FONTS[family];
    return <span key={from} style={style}>{text}</span>;
  });
}

/** A block's nested text nodes together equal block.text, so typography never changes source offsets. */
const BlockText = memo(function BlockText({ block, bookId, tag, tabbable }: { block: Block; bookId: string; tag: ReturnType<typeof headingTags>[number]; tabbable: boolean }) {
  const tabIndex = tabbable ? 0 : -1;
  const style = typography(block.style);
  if (block.type === "image") {
    const image = block.image;
    // Figures are private book assets, never remote URLs or executable document content.
    if (!image || !/^figures\/[a-f0-9]{64}\.png$/.test(image.src)) return null;
    const src = `/api/books/${encodeURIComponent(bookId)}/${image.src}`;
    const sized = Number.isInteger(image.width) && image.width > 0 && Number.isInteger(image.height) && image.height > 0;
    const widths = sized ? [480, 960, 1440].filter((width) => width < image.width) : [];
    const srcSet = widths.length ? [...widths.map((width) => `${src}?width=${width} ${width}w`), `${src} ${image.width}w`].join(", ") : undefined;
    return (
      <figure className="book-figure" data-book-figure={block.id} data-fixed-size={sized ? "" : undefined}>
        <img src={src} srcSet={srcSet} sizes={srcSet ? `auto, (max-width: 72rem) 100vw, ${image.width}px` : undefined}
          style={sized ? { width: `min(100%, ${image.width}px)`, aspectRatio: `${image.width} / ${image.height}` } : undefined}
          width={image.width} height={image.height} alt={image.alt} loading="lazy" decoding="async" />
      </figure>
    );
  }
  if (block.type === "table" && block.rows?.length && block.rows.map((row) => row.join("\t")).join("\n") === block.text) {
    let offset = 0;
    return (
      <div className="book-table" data-block={block.id} tabIndex={tabIndex} style={style}>
        <table aria-label={`Table on page ${block.page}`}><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => {
          const start = offset;
          offset += cell.length;
          const separator = cellIndex < row.length - 1 ? "\t" : rowIndex < block.rows!.length - 1 ? "\n" : "";
          offset += separator.length;
          return <td key={cellIndex}>{formattedText(block, start, start + cell.length)}{separator && <span className="book-table-separator" aria-hidden="true">{separator}</span>}</td>;
        })}</tr>)}</tbody></table>
      </div>
    );
  }
  if (block.type === "code") {
    return <pre className="book-code" data-block={block.id} tabIndex={tabIndex} style={style}>{formattedText(block)}</pre>;
  }
  if (block.type === "heading" && tag) {
    const Tag = tag;
    return (
      <Tag data-block={block.id} tabIndex={tabIndex} style={style}>
        {formattedText(block)}
      </Tag>
    );
  }
  return (
    <p className={block.format === "list-item" ? "book-list-item" : block.format === "figure-text" ? "book-figure-text" : block.format === "caption" ? "book-caption" : undefined} data-block={block.id} tabIndex={tabIndex} style={style}>
      {formattedText(block)}
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
  useMobileRowRendering(container, blocks, notes, translation?.blocks, translation?.lang);
  const cursor = useWordCursor(blocks.find((block) => block.type !== "image" && block.text.trim())?.id, (word) => ask(word, "keyboard"));
  const tags = useMemo(() => headingTags(blocks), [blocks]);
  const chunks = useMemo(() => {
    const result: { blocks: Block[]; start: number }[] = [];
    blocks.forEach((block, at) => {
      const previous = result.at(-1);
      // Images load independently. Keep them outside static prose containment so one figure
      // cannot force dozens of surrounding paragraphs to render throughout a long scroll.
      if (block.type === "image" || !previous || previous.blocks[0]?.type === "image" || previous.blocks.length === TEXT_CHUNK_SIZE) {
        result.push({ blocks: [block], start: at });
      } else previous.blocks.push(block);
    });
    return result;
  }, [blocks]);

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
      const term = blockOf(range.endContainer) === block && via !== "touch" ? termSpan(range.toString()) : null;
      if (term) {
        const from = offsetInBlock(block, range.startContainer, range.startOffset);
        const termRange = rangeWithin(block, from + term.start, from + term.end);
        if (!termRange) return;
        selection.removeAllRanges();
        onWord({ range: termRange, text: termRange.toString(), chapterId, blockId });
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
      {chunks.map(({ blocks: chunk, start }) => (
        <div className="text-chunk" key={chunk[0]!.id}>
          {chunk.map((block, at) => {
            const translated = translation?.blocks[block.id];
            return (
              <div className="row" key={block.id}>
                {notes
                  .filter((note) => note.blockId === block.id)
                  .map((note) => (
                    <NoteCard key={note.id} note={note} bookId={bookId} latest={note.id === notes.at(-1)?.id} onClose={onCloseNote} onSaveAnswer={onSaveAnswer} />
                  ))}
                <BlockText block={block} bookId={bookId} tag={tags[start + at] ?? null} tabbable={block.id === cursor.tabbable} />
                {/* Translations stay beside the block, so every source offset remains in the original book text. */}
                {translation && translated ? (
                  <p className="block-translation" lang={translation.lang} dir="auto" data-translation-of={block.id}>
                    {translated}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
