import { memo, useEffect, useEffectEvent, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";
import type { Block, LangCode, QuestionNote } from "../../shared/types.ts";
import { TIER_PARAMS, useDeviceTier } from "../deviceTier.ts";
import { headingTags } from "./book.ts";
import { type Chunk, chunksOf } from "./chunkWindow.ts";
import { NoteCard } from "./NoteCard.tsx";
import { blockOf, termSpan, wordRangeAtPoint } from "./textRanges.ts";
import { useChunkWindow } from "./useChunkWindow.ts";
import { useWordCursor } from "./useWordCursor.ts";
import type { Lookup } from "./WordPopover.tsx";
import "./book-content.css";
import { offsetInBlock, rangeWithin } from "./domText.ts";

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
  /** The block the chapter opens at (the reader's saved place), so its text is on the page before the rest. */
  openAt?: string;
};

// How long a touch selection must rest before the bar offers explanations: the handles may still be moving.
const TOUCH_SETTLE_MS = 400;

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

/**
 * A block's nested text nodes together equal block.text, so typography never changes source offsets. Its id is the
 * block's, and `charsBefore` is how much chapter text precedes it, so progress needs no walk over the whole chapter.
 */
const BlockText = memo(function BlockText({ block, bookId, tag, tabbable, charsBefore }: { block: Block; bookId: string; tag: ReturnType<typeof headingTags>[number]; tabbable: boolean; charsBefore: number }) {
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
      <figure className="book-figure" data-book-figure={block.id} data-fixed-size={sized ? "" : undefined} id={block.id}>
        <img src={src} srcSet={srcSet} sizes={srcSet ? `auto, (max-width: 72rem) 100vw, ${image.width}px` : undefined}
          style={sized ? { width: `min(100%, ${image.width}px)`, aspectRatio: `${image.width} / ${image.height}` } : undefined}
          width={image.width} height={image.height} alt={image.alt} loading="lazy" decoding="async" />
      </figure>
    );
  }
  if (block.type === "table" && block.rows?.length && block.rows.map((row) => row.join("\t")).join("\n") === block.text) {
    let offset = 0;
    return (
      <div className="book-table" data-block={block.id} tabIndex={tabIndex} style={style} id={block.id} data-chars-before={charsBefore}>
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
    return <pre className="book-code" data-block={block.id} tabIndex={tabIndex} style={style} id={block.id} data-chars-before={charsBefore}>{formattedText(block)}</pre>;
  }
  if (block.type === "heading" && tag) {
    const Tag = tag;
    return (
      <Tag data-block={block.id} tabIndex={tabIndex} style={style} id={block.id} data-chars-before={charsBefore}>
        {formattedText(block)}
      </Tag>
    );
  }
  return (
    <p className={block.format === "list-item" ? "book-list-item" : block.format === "figure-text" ? "book-figure-text" : block.format === "caption" ? "book-caption" : undefined} data-block={block.id} tabIndex={tabIndex} style={style} id={block.id} data-chars-before={charsBefore}>
      {formattedText(block)}
    </p>
  );
});

type Translation = NonNullable<Props["translation"]>;

type ChunkProps = {
  chunk: Chunk;
  /** The chapter's heading tags, by block index (chunk.start + row). */
  tags: ReturnType<typeof headingTags>;
  /** Chapter text before each block, by block id. */
  charsBefore: Map<string, number>;
  /** The notes on this chunk's blocks, in the book's order. */
  notes: QuestionNote[];
  latestNoteId: string | undefined;
  bookId: string;
  actions: Pick<TextActions, "onCloseNote" | "onSaveAnswer">;
  translation: Translation | undefined;
  /** The one block in the chapter that Tab stops on, when it is in this chunk. */
  tabbable: string | undefined;
  /** Chunks are block wrappers while far ones can be placeholders; on the desktop they stay out of the layout. */
  windowed: boolean;
  attach: (element: HTMLDivElement | null) => () => void;
};

/** Props equal for the rows they draw: a note or a translation arriving in another chunk leaves this one alone. */
function sameRows(previous: ChunkProps, next: ChunkProps): boolean {
  if (previous.chunk !== next.chunk || previous.tags !== next.tags || previous.charsBefore !== next.charsBefore) return false;
  if (previous.bookId !== next.bookId || previous.actions !== next.actions || previous.tabbable !== next.tabbable || previous.windowed !== next.windowed || previous.attach !== next.attach) return false;
  if (previous.notes.length !== next.notes.length || previous.notes.some((note, at) => note !== next.notes[at])) return false;
  if ((previous.latestNoteId !== next.latestNoteId) && (previous.notes.length > 0 || next.notes.length > 0)) return false;
  if (previous.translation === next.translation) return true;
  if (!previous.translation || !next.translation || previous.translation.lang !== next.translation.lang) return false;
  return next.chunk.blocks.every((block) => previous.translation!.blocks[block.id] === next.translation!.blocks[block.id]);
}

/** The rows of one chunk: each block, the notes on it, and its translation under it. */
const TextChunk = memo(function TextChunk({ chunk, tags, charsBefore, notes, latestNoteId, bookId, actions, translation, tabbable, windowed, attach }: ChunkProps) {
  return (
    <div ref={attach} className="text-chunk" data-chunk={chunk.key} data-window={windowed ? "" : undefined}>
      {chunk.blocks.map((block, at) => {
        const translated = translation?.blocks[block.id];
        return (
          <div className="row" key={block.id}>
            {notes
              .filter((note) => note.blockId === block.id)
              .map((note) => (
                <NoteCard key={note.id} note={note} bookId={bookId} latest={note.id === latestNoteId} onClose={actions.onCloseNote} onSaveAnswer={actions.onSaveAnswer} />
              ))}
            <BlockText block={block} bookId={bookId} tag={tags[chunk.start + at] ?? null} tabbable={block.id === tabbable} charsBefore={charsBefore.get(block.id) ?? 0} />
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
  );
}, sameRows);

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

const EMPTY_NOTES: QuestionNote[] = [];

/**
 * The text of one chapter. A tap on a word looks it up; a selection offers explanations. Both work by keyboard too.
 * On a phone only the chunks of rows near the reader are on the page; the rest hold their place as empty boxes of the
 * same height (useChunkWindow), so a chapter of thousands of paragraphs costs what is near the reader.
 */
export function ChapterText({ blocks, notes, bookId, chapterId, actions, translation, openAt }: Props) {
  const { onWord, onSelect, onDismiss, onCloseNote, onSaveAnswer } = actions;
  const container = useRef<HTMLDivElement>(null);
  const params = TIER_PARAMS[useDeviceTier()];
  // The cursor moves through the chapter's blocks in book order, so it can step into a chunk that is still a placeholder.
  const order = useMemo(() => ({ chapterId, blockIds: blocks.filter((block) => block.type !== "image").map((block) => block.id) }), [chapterId, blocks]);
  const cursor = useWordCursor(blocks.find((block) => block.type !== "image" && block.text.trim())?.id, (word) => ask(word, "keyboard"), order);
  const tags = useMemo(() => headingTags(blocks), [blocks]);
  const chunks = useMemo(() => chunksOf(blocks, params.rowsPerChunk), [blocks, params.rowsPerChunk]);
  // How much of the chapter's text comes before each block: the same count the server makes for the shelf.
  const charsBefore = useMemo(() => {
    const before = new Map<string, number>();
    let total = 0;
    for (const block of blocks) {
      if (block.type === "image") continue;
      before.set(block.id, total);
      total += block.text.length;
    }
    return before;
  }, [blocks]);
  const notesByChunk = useMemo(() => {
    const byChunk = new Map<string, QuestionNote[]>();
    const keyOf = new Map<string, string>();
    for (const chunk of chunks) for (const block of chunk.blocks) keyOf.set(block.id, chunk.key);
    for (const note of notes) {
      const key = keyOf.get(note.blockId);
      if (!key) continue;
      const list = byChunk.get(key) ?? [];
      list.push(note);
      byChunk.set(key, list);
    }
    return byChunk;
  }, [chunks, notes]);
  const noteChunks = useMemo(() => new Set(notesByChunk.keys()), [notesByChunk]);
  const chunkWindow = useChunkWindow({ container, bookId, chapterId, chunks, noteChunks, params, openAt, translated: translation !== undefined });
  const cardActions = useMemo(() => ({ onCloseNote, onSaveAnswer }), [onCloseNote, onSaveAnswer]);
  const latestNoteId = notes.at(-1)?.id;

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

  const { mounted } = chunkWindow;
  const windowed = mounted !== "all";
  return (
    <div
      ref={container}
      className="chapter-text"
      onMouseUp={handleMouseUp}
      onKeyDown={cursor.onKeyDown}
      onFocus={cursor.onFocus}
      onBlur={cursor.onBlur}
    >
      {chunks.map((chunk) =>
        windowed && !mounted.has(chunk.key) ? (
          // Holds the chunk's place at its measured (or estimated) height until the reader comes near.
          <div key={chunk.key} ref={chunkWindow.chunkRef(chunk.key)} className="text-chunk" data-chunk={chunk.key} data-window="" data-placeholder="" style={{ height: `${chunkWindow.heightFor(chunk)}px` }} />
        ) : (
          <TextChunk
            key={chunk.key}
            chunk={chunk}
            tags={tags}
            charsBefore={charsBefore}
            notes={notesByChunk.get(chunk.key) ?? EMPTY_NOTES}
            latestNoteId={latestNoteId}
            bookId={bookId}
            actions={cardActions}
            translation={translation}
            tabbable={chunk.blocks.some((block) => block.id === cursor.tabbable) ? cursor.tabbable : undefined}
            windowed={windowed}
            attach={chunkWindow.chunkRef(chunk.key)}
          />
        ),
      )}
    </div>
  );
}
