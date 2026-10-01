import { ArrowLeft, ArrowUp, Headphones, List } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import type { BookDetail, ExplainMode } from "../../shared/types.ts";
import { api } from "../api.ts";
import { usePrefs } from "../prefs.ts";
import { readableBlocks } from "./book.ts";
import { ChapterList } from "./ChapterList.tsx";
import { ChapterSection } from "./ChapterSection.tsx";
import type { TextActions } from "./ChapterText.tsx";
import { ListenBar } from "./ListenBar.tsx";
import { listenBlocks } from "./listenBlocks.ts";
import { ReadingSettings } from "./ReadingSettings.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { canSpeak } from "./speech.ts";
import { setHighlight } from "./textRanges.ts";
import { useChapterFlow } from "./useChapterFlow.ts";
import { useListen } from "./useListen.ts";
import { useNotes } from "./useNotes.ts";
import { blockAtTop, EYE_LINE, useReadingPosition } from "./useReadingPosition.ts";
import { WordPopover, type Lookup } from "./WordPopover.tsx";

type Props = { bookId: string; chapterId: string | null };

/** The book read start to finish as one flow: chapters follow each other as the reader scrolls. */
export function ReaderPage({ bookId, chapterId }: Props) {
  const prefs = usePrefs();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [word, setWord] = useState<Lookup | null>(null);
  const [selection, setSelection] = useState<Lookup | null>(null);
  const { notes, addNote, removeNote } = useNotes(bookId);
  const flow = useChapterFlow(bookId, chapterId, book);
  const first = flow.chapters[0];
  const position = useReadingPosition(bookId, chapterId, book, first);

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
  const listen = useListen(blocks, prefs.rate, nextChapter);
  const { active: listenActive, stop: stopListen } = listen;
  const listenButton = useRef<HTMLButtonElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const focusPlayer = useRef(false);

  // The book restarted at another chapter: open popovers would point into text that is gone.
  useEffect(() => {
    setWord(null);
    setSelection(null);
  }, [first]);

  useEffect(() => {
    setHighlight("dr-word", word?.range ?? null);
    return () => setHighlight("dr-word", null);
  }, [word]);

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
      if (event.key !== "Escape" || tocOpen) return;
      if (word || selection) {
        dismiss();
      } else if (listenActive) {
        stopListening();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, word, selection, tocOpen, listenActive, stopListening]);

  // A keyboard reader who starts listening lands on the player, so Pause and Next are right there.
  useEffect(() => {
    if (!focusPlayer.current || !playButton.current) return;
    focusPlayer.current = false;
    playButton.current.focus();
  });

  const handleWord = useCallback((lookup: Lookup) => {
    setSelection(null);
    setWord(lookup);
  }, []);

  const handleSelect = useCallback((lookup: Lookup) => {
    setWord(null);
    setSelection(lookup);
  }, []);

  const actions = useMemo<TextActions>(
    () => ({ onWord: handleWord, onSelect: handleSelect, onDismiss: dismiss, onCloseNote: removeNote }),
    [handleWord, handleSelect, dismiss, removeNote],
  );

  function explain(mode: ExplainMode) {
    if (!selection) return;
    addNote({ chapterId: selection.chapterId, blockId: selection.blockId, quote: selection.text, mode });
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
    listen.startAtLine(start, EYE_LINE);
  }

  const pageError = error ?? flow.error;
  if (pageError) {
    return (
      <main className="page-message">
        <p>{pageError}</p>
        <Link href="/" className="button">
          Back to your books
        </Link>
      </main>
    );
  }

  const currentTitle = book?.chapters.find((item) => item.id === position.chapterId)?.title;

  return (
    <div className="reader">
      <header className="topbar">
        <Link href="/" className="icon-button" aria-label="Back to your books">
          <ArrowLeft size={20} aria-hidden />
        </Link>
        <button type="button" className="icon-button" aria-label="Chapters" aria-expanded={tocOpen} onClick={() => setTocOpen(true)}>
          <List size={20} aria-hidden />
        </button>
        <p className="topbar-title">
          {book?.title ?? ""}
          {currentTitle && <span className="topbar-chapter"> · {currentTitle}</span>}
        </p>
        {book && (
          <span className="topbar-percent" aria-hidden>
            {position.percent}%
          </span>
        )}
        <div className="topbar-tools">
          {canSpeak && (
            <button
              ref={listenButton}
              type="button"
              className="quiet-button"
              onClick={listen.active ? stopListening : listenFromView}
              aria-pressed={listen.active}
            >
              <Headphones size={18} aria-hidden /> Listen
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

      {/* Right after the top bar in the page order, so a keyboard reader reaches it in a Tab or two. It is fixed to the window, so it looks the same. */}
      {listen.active && <ListenBar listen={listen} rate={prefs.rate} playRef={playButton} onStop={stopListening} />}

      {tocOpen && book && <ChapterList book={book} currentId={position.chapterId ?? chapterId} onClose={() => setTocOpen(false)} />}

      <main className="page" style={{ paddingBottom: listen.active ? "9rem" : undefined }}>
        {!book || !first ? (
          <p className="page-wait">Opening the chapter...</p>
        ) : (
          <>
            {flow.previous && (
              <p className="flow-back">
                <Link href={`/book/${bookId}/${flow.previous.id}`} className="flow-back-link">
                  <ArrowUp size={18} aria-hidden />
                  <span>Previous: {flow.previous.title}</span>
                </Link>
              </p>
            )}
            {flow.chapters.map((chapter) => (
              <ChapterSection key={chapter.id} chapter={chapter} book={book} notes={notes} lang={prefs.lang} actions={actions} />
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
              <p className="flow-end">End of the book</p>
            )}
          </>
        )}
      </main>

      {word && (
        <WordPopover
          key={`${word.blockId}-${word.range.startOffset}-${word.text}`}
          lookup={word}
          bookId={bookId}
          lang={prefs.lang}
          onListenFromHere={() => listenFrom(word)}
          onClose={dismiss}
        />
      )}
      {selection && (
        <SelectionBar range={selection.range} lang={prefs.lang} onExplain={explain} onListen={() => listenFrom(selection)} />
      )}
    </div>
  );
}
