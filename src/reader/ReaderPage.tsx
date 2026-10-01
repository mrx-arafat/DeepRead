import { ArrowLeft, ArrowRight, Headphones, List, Moon, Sun, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LANGUAGES,
  type BookDetail,
  type Chapter,
  type ExplainMode,
  type LangCode,
} from "../../shared/types.ts";
import { api } from "../api.ts";
import { FONT_SIZES, setPrefs, usePrefs } from "../prefs.ts";
import { ChapterAid } from "./ChapterAid.tsx";
import { ChapterText } from "./ChapterText.tsx";
import { ListenBar } from "./ListenBar.tsx";
import type { Note } from "./NoteCard.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { canSpeak } from "./speech.ts";
import { blockOf, setHighlight } from "./textRanges.ts";
import { useListen } from "./useListen.ts";
import { WordPopover, type Lookup } from "./WordPopover.tsx";

type Props = { bookId: string; chapterId: string | null };

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Minutes to read `words` at a relaxed pace. */
const minutes = (words: number) => Math.max(1, Math.round(words / 180));

// Notes outlive a page reload. Only the request is kept: the server caches the answers.
const notesKey = (bookId: string, chapterId: string) => `deepread.notes.${bookId}.${chapterId}`;

function loadNotes(bookId: string, chapterId: string): Note[] {
  try {
    return JSON.parse(localStorage.getItem(notesKey(bookId, chapterId)) ?? "[]") as Note[];
  } catch {
    return [];
  }
}

function saveNotes(bookId: string, chapterId: string, notes: Note[]) {
  try {
    if (notes.length) localStorage.setItem(notesKey(bookId, chapterId), JSON.stringify(notes));
    else localStorage.removeItem(notesKey(bookId, chapterId));
  } catch {
    // Storage unavailable: notes still work until the page is closed.
  }
}

export function ReaderPage({ bookId, chapterId }: Props) {
  const prefs = usePrefs();
  const [, navigate] = useLocation();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [word, setWord] = useState<Lookup | null>(null);
  const [selection, setSelection] = useState<Lookup | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const restoreTo = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getBook(bookId)
      .then((detail) => {
        if (cancelled) return;
        setBook(detail);
        restoreTo.current = detail.progress?.blockId ?? null;
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // No chapter in the URL: continue where the reader stopped, or start at the beginning.
  useEffect(() => {
    if (chapterId || !book) return;
    const target = book.progress?.chapterId ?? book.chapters[0]?.id;
    if (target) navigate(`/book/${bookId}/${target}`, { replace: true });
    else setError("This book has no chapters to read.");
  }, [book, bookId, chapterId, navigate]);

  useEffect(() => {
    if (!chapterId) return;
    const controller = new AbortController();
    setChapter(null);
    setNotes(loadNotes(bookId, chapterId));
    setWord(null);
    setSelection(null);
    api
      .getChapter(bookId, chapterId, controller.signal)
      .then(setChapter)
      .catch((err: Error) => !controller.signal.aborted && setError(err.message));
    return () => controller.abort();
  }, [bookId, chapterId]);

  // The chapter title is already the page heading: do not repeat it as the first block.
  const blocks = useMemo(() => {
    if (!chapter) return [];
    const [first, ...rest] = chapter.blocks;
    return first?.type === "heading" && normalize(first.text) === normalize(chapter.title) ? rest : chapter.blocks;
  }, [chapter]);

  const listen = useListen(blocks, prefs.rate);

  // Open the chapter where the reader left it, otherwise at the top.
  useEffect(() => {
    if (!chapter) return;
    const target = restoreTo.current;
    restoreTo.current = null;
    const element = target && document.querySelector(`[data-block="${CSS.escape(target)}"]`);
    if (element) element.scrollIntoView({ block: "start" });
    else window.scrollTo({ top: 0 });
  }, [chapter]);

  // Remember the paragraph at the top of the window as reading progress.
  useEffect(() => {
    if (!chapter) return;
    let saved: string | null = null;
    let timer: number | undefined;
    const save = () => {
      const column = document.querySelector(".chapter-text")?.getBoundingClientRect();
      if (!column) return;
      const blockId = blockOf(document.elementFromPoint(column.left + 24, 96))?.dataset.block;
      if (!blockId || blockId === saved) return;
      saved = blockId;
      api.saveProgress(bookId, chapter.id, blockId).catch(() => {
        // Progress is a convenience; reading must not be interrupted if saving fails.
      });
    };
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 1200);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, [bookId, chapter]);

  useEffect(() => {
    setHighlight("dr-word", word?.range ?? null);
    return () => setHighlight("dr-word", null);
  }, [word]);

  const dismiss = useCallback(() => {
    setWord(null);
    setSelection(null);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismiss();
      setTocOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const handleWord = useCallback((lookup: Lookup) => {
    setSelection(null);
    setWord(lookup);
  }, []);

  const handleSelect = useCallback((lookup: Lookup) => {
    setWord(null);
    setSelection(lookup);
  }, []);

  const changeNotes = useCallback(
    (change: (all: Note[]) => Note[]) => {
      if (!chapterId) return;
      setNotes((all) => {
        const next = change(all);
        saveNotes(bookId, chapterId, next);
        return next;
      });
    },
    [bookId, chapterId],
  );

  const closeNote = useCallback(
    (id: string) => changeNotes((all) => all.filter((note) => note.id !== id)),
    [changeNotes],
  );

  function explain(mode: ExplainMode) {
    if (!selection) return;
    const { blockId, text } = selection;
    changeNotes((all) => [
      ...all.filter((note) => !(note.blockId === blockId && note.quote === text && note.mode === mode)),
      { id: crypto.randomUUID(), blockId, quote: text, mode },
    ]);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  function listenFrom(lookup: Lookup) {
    listen.startAt(lookup.blockId, lookup.range.startOffset);
    window.getSelection()?.removeAllRanges();
    dismiss();
  }

  function listenFromView() {
    const column = document.querySelector(".chapter-text")?.getBoundingClientRect();
    const visible = column && blockOf(document.elementFromPoint(column.left + 24, 96))?.dataset.block;
    const start = visible ?? blocks[0]?.id;
    if (start) listen.startAt(start);
  }

  if (error) {
    return (
      <main className="page-message">
        <p>{error}</p>
        <Link href="/" className="button">
          Back to your books
        </Link>
      </main>
    );
  }

  const position = book && chapter ? book.chapters.findIndex((item) => item.id === chapter.id) : -1;
  const previous = book && position > 0 ? book.chapters[position - 1] : undefined;
  const next = book && position >= 0 ? book.chapters[position + 1] : undefined;
  const summary = book?.chapters[position];

  return (
    <div className="reader">
      <header className="topbar">
        <Link href="/" className="icon-button" aria-label="Back to your books">
          <ArrowLeft size={20} aria-hidden />
        </Link>
        <button type="button" className="icon-button" aria-label="Chapters" aria-expanded={tocOpen} onClick={() => setTocOpen(true)}>
          <List size={20} aria-hidden />
        </button>
        <p className="topbar-title">{book?.title ?? ""}</p>
        <div className="topbar-tools">
          {canSpeak && (
            <button type="button" className="quiet-button" onClick={listen.active ? listen.stop : listenFromView} aria-pressed={listen.active}>
              <Headphones size={18} aria-hidden /> Listen
            </button>
          )}
          <label className="topbar-lang">
            <span className="visually-hidden">Your language</span>
            <select value={prefs.lang} onChange={(event) => setPrefs({ lang: event.target.value as LangCode })}>
              {Object.entries(LANGUAGES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="icon-button text-size"
            aria-label="Smaller text"
            disabled={prefs.fontSize <= FONT_SIZES.min}
            onClick={() => setPrefs({ fontSize: prefs.fontSize - 1 })}
          >
            A
          </button>
          <button
            type="button"
            className="icon-button text-size text-size-large"
            aria-label="Larger text"
            disabled={prefs.fontSize >= FONT_SIZES.max}
            onClick={() => setPrefs({ fontSize: prefs.fontSize + 1 })}
          >
            A
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={prefs.theme === "dark" ? "Switch to light" : "Switch to dark"}
            onClick={() => setPrefs({ theme: prefs.theme === "dark" ? "light" : "dark" })}
          >
            {prefs.theme === "dark" ? <Sun size={20} aria-hidden /> : <Moon size={20} aria-hidden />}
          </button>
        </div>
      </header>

      {tocOpen && book && (
        <>
          <div className="scrim" onClick={() => setTocOpen(false)} />
          <nav className="toc" aria-label="Chapters">
            <header className="toc-head">
              <h2>Chapters</h2>
              <button type="button" className="icon-button" aria-label="Close chapters" onClick={() => setTocOpen(false)}>
                <X size={20} aria-hidden />
              </button>
            </header>
            <ol>
              {book.chapters.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/book/${bookId}/${item.id}`}
                    className="toc-link"
                    aria-current={item.id === chapterId ? "page" : undefined}
                    onClick={() => setTocOpen(false)}
                  >
                    <span>{item.title}</span>
                    <span className="toc-time">{minutes(item.wordCount)} min</span>
                  </Link>
                </li>
              ))}
            </ol>
          </nav>
        </>
      )}

      <main className="page">
        {!chapter ? (
          <p className="page-wait">Opening the chapter...</p>
        ) : (
          <article className="chapter" style={{ paddingBottom: listen.active ? "9rem" : undefined }}>
            <header className="chapter-head">
              <p className="chapter-meta">
                Chapter {position + 1} of {book?.chapters.length ?? ""}
                {summary ? ` · about ${minutes(summary.wordCount)} min` : ""}
              </p>
              <h1>{chapter.title}</h1>
            </header>

            <ChapterAid key={`preview-${chapter.id}`} kind="preview" bookId={bookId} chapterId={chapter.id} lang={prefs.lang} />

            <ChapterText
              blocks={blocks}
              notes={notes}
              bookId={bookId}
              chapterId={chapter.id}
              lang={prefs.lang}
              onWord={handleWord}
              onSelect={handleSelect}
              onDismiss={dismiss}
              onCloseNote={closeNote}
            />

            <ChapterAid key={`recap-${chapter.id}`} kind="recap" bookId={bookId} chapterId={chapter.id} lang={prefs.lang} />

            <nav className="chapter-nav" aria-label="Other chapters">
              {previous ? (
                <Link href={`/book/${bookId}/${previous.id}`} className="chapter-nav-link">
                  <ArrowLeft size={18} aria-hidden />
                  <span>{previous.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link href={`/book/${bookId}/${next.id}`} className="chapter-nav-link chapter-nav-next">
                  <span>{next.title}</span>
                  <ArrowRight size={18} aria-hidden />
                </Link>
              )}
            </nav>
          </article>
        )}
      </main>

      {word && chapter && (
        <WordPopover
          key={`${word.blockId}-${word.range.startOffset}-${word.text}`}
          lookup={word}
          bookId={bookId}
          chapterId={chapter.id}
          lang={prefs.lang}
          onListenFromHere={() => listenFrom(word)}
          onClose={dismiss}
        />
      )}
      {selection && (
        <SelectionBar range={selection.range} lang={prefs.lang} onExplain={explain} onListen={() => listenFrom(selection)} />
      )}
      {listen.active && <ListenBar listen={listen} rate={prefs.rate} />}
    </div>
  );
}
