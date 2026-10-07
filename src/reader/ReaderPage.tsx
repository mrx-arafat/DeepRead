import { ArrowLeft, ChevronLeft, ChevronRight, Headphones, List, NotebookPen, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import type { BookDetail, ExplainMode, Note } from "../../shared/types.ts";
import { api } from "../api.ts";
import { readerTitle, useDocumentTitle } from "../pageTitle.ts";
import { usePrefs } from "../prefs.ts";
import { readableBlocks } from "./book.ts";
import { BookSearch } from "./BookSearch.tsx";
import type { BookSearchResult } from "./bookSearch.ts";
import { quoteStart } from "./highlights.ts";
import { ChapterList } from "./ChapterList.tsx";
import { ChapterSection } from "./ChapterSection.tsx";
import type { TextActions } from "./ChapterText.tsx";
import { ListenBar } from "./ListenBar.tsx";
import { NoteSyncStatus } from "./NoteSyncStatus.tsx";
import { Notebook, type NotebookDraft } from "./Notebook.tsx";
import { notebookSource, type NotebookSource } from "./notebookSource.ts";
import { listenBlocks } from "./listenBlocks.ts";
import { lookupTipDone, markLookupTipDone } from "./lookupTip.ts";
import { ReadingSettings } from "./ReadingSettings.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { canSpeak } from "./speech.ts";
import { rangeInBlock, setHighlight } from "./textRanges.ts";
import { UndoToast } from "./UndoToast.tsx";
import { useChapterFlow } from "./useChapterFlow.ts";
import { useHighlightChoice } from "./useHighlightChoice.ts";
import { useListen } from "./useListen.ts";
import { useNaturalVoice } from "./useNaturalVoice.ts";
import { useNoteMarks } from "./useNoteMarks.ts";
import { useNotes } from "./useNotes.ts";
import { usePages } from "./usePages.ts";
import { blockAtTop, eyeLine, useReadingPosition } from "./useReadingPosition.ts";
import { WordPopover, type Lookup } from "./WordPopover.tsx";

type Props = { bookId: string; chapterId: string | null };

/** How long the chapter has left, as an e-reader's footer says it. */
function timeLeft(minutes: number | null): string {
  if (minutes === null) return "";
  return minutes === 0 ? "Less than a minute left in chapter" : `${minutes} min left in chapter`;
}

/** The same, counted in pages, for a reader turning them. */
function pagesLeftText(pages: number): string {
  if (pages === 0) return "Last page in chapter";
  return pages === 1 ? "1 page left in chapter" : `About ${pages} pages left in chapter`;
}

/** The book read start to finish as one flow: chapters follow each other as the reader scrolls. */
export function ReaderPage({ bookId, chapterId }: Props) {
  const prefs = usePrefs();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [notebookDraft, setNotebookDraft] = useState<NotebookDraft | null>(null);
  const [sourceTarget, setSourceTarget] = useState<NotebookSource | null>(null);
  const [word, setWord] = useState<Lookup | null>(null);
  const [selection, setSelection] = useState<Lookup | null>(null);
  // Until the reader has looked something up, a tip beside the first chapter shows how.
  const [tipOpen, setTipOpen] = useState(() => !lookupTipDone());
  const { allNotes, notes, highlights, addNote, addHighlight, saveReflection, saveAnswer, removeNote, removed, restoreNote, forgetRemoved, syncState, retryNotes, discardRejectedNotes } = useNotes(bookId, prefs.lang);
  const [undoFocus, setUndoFocus] = useState(false);
  // What takes focus back after Undo, when focus was on it.
  const focusAfterUndo = useRef<string | null>(null);
  const flow = useChapterFlow(bookId, chapterId, book);
  // The chapters are on the page only once the book's details are in as well.
  const shown = useMemo(() => (book ? flow.chapters : []), [book, flow.chapters]);
  useNoteMarks(notes, highlights, shown);
  const position = useReadingPosition(bookId, chapterId, book, flow.start);
  const noteNeedsAttention = Boolean(book && syncState.phase !== "saved" && syncState.phase !== "saving");
  const turning = prefs.layout === "pages";
  const pages = usePages(turning, Boolean(book && flow.start), Boolean(word || selection));

  useEffect(() => {
    let cancelled = false;
    api
      .getBook(bookId)
      .then((detail) => !cancelled && setBook(detail))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // Everything read aloud, in reading order: listening carries on from one chapter's end into the next one's title.
  const blocks = useMemo(() => listenBlocks(flow.chapters), [flow.chapters]);
  const nextChapter = useMemo(
    () => ({ coming: flow.hasMore, error: flow.nextError, open: flow.loadNext }),
    [flow.hasMore, flow.nextError, flow.loadNext],
  );
  useNaturalVoice(prefs.voice);
  const listen = useListen(blocks, prefs.rate, nextChapter);
  const { active: listenActive, stop: stopListen } = listen;
  const listenButton = useRef<HTMLButtonElement>(null);
  const notebookButton = useRef<HTMLButtonElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const focusPlayer = useRef(false);

  // The book restarted at another chapter: open popovers would point into text that is gone.
  // A tip the reader has already used (and that was only fading) goes now, rather than reappearing here.
  useEffect(() => {
    setWord(null);
    setSelection(null);
    if (lookupTipDone()) setTipOpen(false);
  }, [flow.start]);

  useEffect(() => {
    setHighlight("dr-word", word?.range ?? null);
    return () => setHighlight("dr-word", null);
  }, [word]);

  useEffect(() => {
    const range = sourceTarget && position.detour
      ? rangeInBlock(sourceTarget.blockId, { start: sourceTarget.offset, end: sourceTarget.offset + sourceTarget.matchLength })
      : null;
    setHighlight("dr-search", range);
    return () => setHighlight("dr-search", null);
  }, [sourceTarget, flow.chapters, position.detour]);

  const dismiss = useCallback(() => {
    setWord(null);
    setSelection(null);
  }, []);

  // Stopping from inside the player must not drop a keyboard reader's focus into the page body.
  const stopListening = useCallback(() => {
    const inPlayer = playButton.current?.closest(".listen-bar")?.contains(document.activeElement);
    stopListen();
    if (inPlayer) listenButton.current?.focus();
  }, [stopListen]);

  // Escape closes the topmost thing: a popover first, then the player.
  // The chapter list is a modal dialog that closes itself and puts focus back, so it is left to do that.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || tocOpen || document.querySelector(":popover-open")) return;
      if (word || selection) {
        dismiss();
      } else if (listenActive) {
        stopListening();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, word, selection, tocOpen, listenActive, stopListening]);

  // A press anywhere outside the word card or the Explain bar closes it, like any popover: the margin, a gap
  // between paragraphs, a title, the top bar. A press on the book text is left to ChapterText, which opens the
  // next word or selection there, or closes them, once the press ends.
  useEffect(() => {
    if (!word && !selection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (event.target.closest(".word-popover, .selection-bar, [data-block]")) return;
      dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [dismiss, word, selection]);

  // A keyboard reader who starts listening lands on the player, so Pause and Next are right there.
  useEffect(() => {
    if (!focusPlayer.current || !playButton.current) return;
    focusPlayer.current = false;
    playButton.current.focus();
  });

  const closeTip = useCallback(() => {
    markLookupTipDone();
    setTipOpen(false);
  }, []);

  // A word looked up or an explanation asked for means the tip has done its job. A mere selection does not:
  // the reader may still be adjusting it with the handles.
  const handleWord = useCallback((lookup: Lookup) => {
    markLookupTipDone();
    setSelection(null);
    setWord(lookup);
  }, []);

  const handleSelect = useCallback((lookup: Lookup) => {
    setWord(null);
    setSelection(lookup);
  }, []);

  // A keyboard reader's focus was on the card's Remove button, which is gone: it goes to Undo, not the page body.
  const closeNote = useCallback(
    (id: string, byKeyboard: boolean) => {
      setUndoFocus(byKeyboard);
      removeNote(id);
    },
    [removeNote],
  );

  /**
   * Puts the removed note back. Focus on Undo goes back to the note's Remove button, as if it had never gone, or, for a
   * highlight, to its paragraph, where the reader was.
   */
  function undoRemove() {
    if (removed && document.activeElement?.closest(".toast")) {
      focusAfterUndo.current =
        removed.mode === "highlight"
          ? `[data-block="${CSS.escape(removed.blockId)}"]`
          : `[data-note="${removed.id}"] button[aria-label="Remove note"]`;
    }
    restoreNote();
  }

  useEffect(() => {
    if (!focusAfterUndo.current) return;
    document.querySelector<HTMLElement>(focusAfterUndo.current)?.focus();
    focusAfterUndo.current = null;
  });

  const actions = useMemo<TextActions>(
    () => ({ onWord: handleWord, onSelect: handleSelect, onDismiss: dismiss, onCloseNote: closeNote, onSaveAnswer: saveAnswer }),
    [handleWord, handleSelect, dismiss, closeNote, saveAnswer],
  );

  const selectionDraft = useMemo<NotebookDraft | null>(() => {
    if (!selection) return null;
    const chapter = flow.chapters.find((item) => item.id === selection.chapterId);
    if (!chapter) return null;
    const from = selection.range.startContainer instanceof Text ? selection.range.startOffset : 0;
    const source = quoteStart(readableBlocks(chapter), selection.blockId, selection.text, from);
    return source ? { chapterId: chapter.id, blockId: source.blockId, quote: selection.text, offset: source.offset } : null;
  }, [selection, flow.chapters]);

  function explain(mode: ExplainMode) {
    if (!selection) return;
    markLookupTipDone();
    addNote({ chapterId: selection.chapterId, blockId: selection.blockId, quote: selection.text, mode,
      ...(selectionDraft ? { offset: selectionDraft.offset } : {}) });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  // A highlight made, changed or removed closes the bar or the card that offered it, as Explain does.
  const closeLookup = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    dismiss();
  }, [dismiss]);
  const highlighting = { highlights, addHighlight, removeNote };
  const selectionHighlight = useHighlightChoice(selection, flow.chapters, highlighting, closeLookup);
  const wordHighlight = useHighlightChoice(word, flow.chapters, highlighting, closeLookup);

  function reflect() {
    if (!selectionDraft) return;
    markLookupTipDone();
    setNotebookDraft(selectionDraft);
    setNotebookOpen(true);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  /** Whoever starts listening from the keyboard should find the player under their fingers. */
  function rememberKeyboardStart() {
    focusPlayer.current = document.activeElement?.matches(":focus-visible") ?? false;
  }

  function listenFrom(lookup: Lookup) {
    rememberKeyboardStart();
    listen.startAt(lookup.blockId, lookup.range.startOffset);
    window.getSelection()?.removeAllRanges();
    dismiss();
  }

  function listenFromView() {
    const current = flow.chapters.find((chapter) => chapter.id === position.chapterId);
    const start = blockAtTop()?.dataset.block ?? (current && readableBlocks(current)[0]?.id) ?? blocks[0]?.id;
    if (!start) return;
    rememberKeyboardStart();
    listen.startAtLine(start, eyeLine());
  }

  function openSearchResult(result: BookSearchResult): boolean {
    const opened = position.visitPlace({ chapterId: result.chapterId, blockId: result.blockId, offset: result.offset });
    if (opened) setSourceTarget(result);
    return opened;
  }

  async function openNotebookSource(note: Note): Promise<boolean> {
    const chapter = await api.getChapter(bookId, note.chapterId);
    const source = notebookSource(note, chapter);
    if (!source) return false;
    if (!position.visitPlace(source)) throw new Error("Could not save the current reading place.");
    setSourceTarget(source);
    return true;
  }

  const pageError = error ?? flow.error;
  const currentTitle = book?.chapters.find((item) => item.id === position.chapterId)?.title;
  // The tab and the history menu name the book and the chapter being read, so several tabs do not look alike.
  useDocumentTitle(readerTitle(pageError ? undefined : book?.title, currentTitle));

  if (pageError) {
    return (
      <main className="page-message">
        <p>{pageError}</p>
        {flow.error && position.detour?.returning && (
          <button type="button" className="button" onClick={position.cancelReturn}>Back to passage</button>
        )}
        <Link href="/" className="button">
          Back to your books
        </Link>
      </main>
    );
  }

  return (
    <div className="reader">
      <header className={pages.barAway && !tocOpen ? "topbar topbar-away" : "topbar"}>
        <Link href="/" className="icon-button" aria-label="Back to your books">
          <ArrowLeft size={20} aria-hidden />
        </Link>
        <button type="button" className="icon-button" aria-label="Chapters" aria-expanded={tocOpen} onClick={() => setTocOpen(true)}>
          <List size={20} aria-hidden />
        </button>
        {/* The page's one h1: the book. Chapter titles are h2; the chapter named here is for the eye alone.
            On a phone the book and the chapter take a line each, so the dot between them is for wider screens. */}
        <h1 className="topbar-title">
          <span className="topbar-book">{book?.title ?? ""}</span>
          {currentTitle && (
            <span className="topbar-chapter" aria-hidden>
              <span className="topbar-dot"> {"\u00b7"} </span>
              {currentTitle}
            </span>
          )}
        </h1>
        {book && (
          <span className="topbar-percent" aria-hidden>
            {position.percent}%
          </span>
        )}
        <div className="topbar-tools">
          {book && (syncState.phase === "saved" || syncState.phase === "saving") && <NoteSyncStatus state={syncState} onRetry={retryNotes} onDiscard={discardRejectedNotes} />}
          {book && (
            <button ref={notebookButton} type="button" className="icon-button" aria-label="Notebook" title="Notebook" onClick={() => { setNotebookDraft(null); setNotebookOpen(true); }}>
              <NotebookPen size={20} aria-hidden />
            </button>
          )}
          {book && (
            <button type="button" className="icon-button" aria-label="Find in this book" onClick={() => setSearchOpen(true)}>
              <Search size={20} aria-hidden />
            </button>
          )}
          {canSpeak && (
            <button
              ref={listenButton}
              type="button"
              className="quiet-button topbar-listen"
              onClick={listen.active ? stopListening : listenFromView}
              aria-pressed={listen.active}
            >
              <Headphones size={18} aria-hidden />
              <span className="topbar-listen-label">Listen</span>
            </button>
          )}
          <ReadingSettings prefs={prefs} />
        </div>
        {book && (
          <div
            className="reading-progress"
            role="progressbar"
            aria-label="Read so far"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={position.percent}
          >
            <span style={{ width: `${position.percent}%` }} />
          </div>
        )}
      </header>

      {(noteNeedsAttention || position.detour) && (
        <div className="reader-overlays">
          {noteNeedsAttention && <NoteSyncStatus state={syncState} onRetry={retryNotes} onDiscard={discardRejectedNotes} />}
          {position.detour && (
            <section className="reading-detour" aria-label="Source visit">
              <p>Visiting a passage</p>
              {position.detourError && <p className="inline-error" role="alert">{position.detourError}</p>}
              <div className="reading-detour__actions">
                <button type="button" className="button" onClick={position.returnToPlace} disabled={position.returning}>
                  <ArrowLeft size={16} aria-hidden /> {position.returning ? "Returning..." : "Return to your place"}
                </button>
                <button type="button" className="quiet-button" onClick={position.stayHere} disabled={position.returning}>Keep reading here</button>
              </div>
            </section>
          )}
        </div>
      )}

      {/* Right after the top bar in the page order, so a keyboard reader reaches it in a Tab or two. It is fixed to the window, so it looks the same. */}
      {listen.active && <ListenBar listen={listen} rate={prefs.rate} playRef={playButton} onStop={stopListening} />}

      {tocOpen && book && <ChapterList book={book} currentId={position.chapterId ?? chapterId} onClose={() => setTocOpen(false)} />}
      {searchOpen && book && <BookSearch book={book} onClose={() => setSearchOpen(false)} onPick={openSearchResult} />}
      {notebookOpen && book && <Notebook
        book={book}
        entries={allNotes}
        initialDraft={notebookDraft}
        removed={removed}
        syncState={syncState}
        actions={{ saveReflection, remove: removeNote, restore: restoreNote, openSource: openNotebookSource, retry: retryNotes, discard: discardRejectedNotes }}
        onClose={() => { setNotebookOpen(false); setNotebookDraft(null); notebookButton.current?.focus(); }}
      />}

      <main className="page" style={{ paddingBottom: listen.active ? "9rem" : undefined }}>
        {!book || !flow.start ? (
          <p className="page-wait">Opening the chapter...</p>
        ) : (
          <>
            {flow.previousError ? (
              <p className="flow-back">
                <span className="inline-error">
                  {flow.previousError}{" "}
                  <button type="button" className="link-button" onClick={flow.loadPrevious}>
                    Try again
                  </button>
                </span>
              </p>
            ) : (
              flow.hasEarlier && (
                <p ref={flow.topSentinel} className="flow-back">
                  {flow.loadingPrevious ? "Opening the previous chapter..." : ""}
                </p>
              )
            )}
            {flow.chapters.map((chapter) => (
              <ChapterSection
                key={chapter.id}
                chapter={chapter}
                book={book}
                notes={notes}
                highlights={highlights}
                lang={prefs.lang}
                actions={actions}
                onDismissTip={chapter === flow.start && tipOpen ? closeTip : undefined}
              />
            ))}
            {flow.nextError ? (
              <p className="flow-end">
                <span className="inline-error">
                  {flow.nextError}{" "}
                  <button type="button" className="link-button" onClick={flow.loadNext}>
                    Try again
                  </button>
                </span>
              </p>
            ) : flow.hasMore ? (
              <p ref={flow.sentinel} className="flow-end">
                {flow.loadingNext ? "Opening the next chapter..." : ""}
              </p>
            ) : (
              <section className="flow-end" aria-labelledby="book-end-title">
                <div className="book-end">
                  <h2 id="book-end-title">End of the book</h2>
                  <p>You have reached the end of {book.title}.</p>
                  <Link href="/" className="button">
                    <ArrowLeft size={18} aria-hidden /> Back to your books
                  </Link>
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {turning && pages.end !== null && (
        <nav className="page-turn-controls" aria-label="Page navigation">
          <button type="button" className="page-turn-button page-turn-previous" aria-label="Previous page" disabled={!pages.canPrevious} onClick={pages.previous}>
            <ChevronLeft size={22} aria-hidden />
          </button>
          <button type="button" className="page-turn-button page-turn-next" aria-label="Next page" disabled={!pages.canNext} onClick={pages.next}>
            <ChevronRight size={22} aria-hidden />
          </button>
        </nav>
      )}

      {/* The e-reader's footer, for the eye: the same progress is the top bar's progress bar for a screen reader.
          The player takes its place while listening. */}
      {book && !listen.active && (
        <footer className="reading-footer" aria-hidden>
          <p className="reading-footer-line">
            <span>
              {turning && pages.left !== null
                ? pagesLeftText(pages.left)
                : position.completed
                  ? "End of the book"
                  : timeLeft(position.minutesLeft)}
            </span>
            {/* Turning pages, the top bar is mostly away, so the footer carries the book's percentage too. */}
            {turning && <span>{position.percent}%</span>}
          </p>
        </footer>
      )}

      {/* Paper over the top margin and over the bottom of the page from the first line that does not fit whole,
          so a page never shows a line cut in half. */}
      {pages.end !== null && (
        <>
          <div className="page-mask page-mask-top" aria-hidden />
          <div className="page-mask page-mask-bottom" style={{ top: pages.end }} aria-hidden />
        </>
      )}

      {/* Always on the page, so a screen reader hears "Note removed" the moment it appears. */}
      <div role="status">
        {removed && (
          <UndoToast
            key={removed.id}
            message={removed.mode === "highlight" ? "Highlight removed" : "Note removed"}
            autoFocus={undoFocus}
            onUndo={undoRemove}
            onTimeout={forgetRemoved}
          />
        )}
      </div>

      {word && (
        <WordPopover
          key={`${word.blockId}-${word.range.startOffset}-${word.text}`}
          lookup={word}
          bookId={bookId}
          lang={prefs.lang}
          onListenFromHere={() => listenFrom(word)}
          onClose={dismiss}
          highlight={wordHighlight}
        />
      )}
      {selection && (
        <SelectionBar
          range={selection.range}
          lang={prefs.lang}
          autoFocus={selection.via === "keyboard"}
          touch={selection.via === "touch"}
          onExplain={explain}
          onListen={() => listenFrom(selection)}
          onReflect={selectionDraft ? reflect : undefined}
          highlight={selectionHighlight}
        />
      )}
    </div>
  );
}
