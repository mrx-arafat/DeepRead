import { Search, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import type { BookDetail, Chapter } from "../../shared/types.ts";
import { api } from "../api.ts";
import { MAX_SEARCH_QUERY_LENGTH, searchChapter, type BookSearchResult } from "./bookSearch.ts";

const RESULT_LIMIT = 40;

type Props = {
  book: BookDetail;
  onClose: () => void;
  onPick: (result: BookSearchResult) => boolean;
};

/** Search a book's authorized chapter text without changing the reader's saved place. */
export function BookSearch({ book, onClose, onPick }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const chapters = useRef(new Map<string, Chapter>());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BookSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);

  useEffect(() => {
    const box = dialog.current;
    box?.showModal();
    input.current?.focus();
    return () => {
      controller.current?.abort();
      if (box?.open) box.close();
    };
  }, []);

  function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === event.currentTarget && outside) dialog.current?.close();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = query.trim();
    if (term.length < 2) return;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setResults([]);
    setError(null);
    setPickError(null);
    setScanned(0);
    setLimited(false);
    setSearched(true);
    setSearching(true);

    const found: BookSearchResult[] = [];
    try {
      for (const summary of book.chapters) {
        let chapter = chapters.current.get(summary.id);
        if (!chapter) {
          chapter = await api.getChapter(book.id, summary.id, next.signal);
          if (next.signal.aborted) return;
          chapters.current.set(summary.id, chapter);
        }
        found.push(...searchChapter(chapter, term, RESULT_LIMIT - found.length));
        setResults([...found]);
        setScanned((count) => count + 1);
        if (found.length >= RESULT_LIMIT) {
          setLimited(true);
          break;
        }
      }
    } catch (cause) {
      if (!next.signal.aborted) setError(cause instanceof Error ? cause.message : "Search could not finish.");
    } finally {
      if (!next.signal.aborted) setSearching(false);
    }
  }

  function pick(result: BookSearchResult) {
    setPickError(null);
    if (onPick(result)) dialog.current?.close();
    else setPickError("Could not capture your current place. Close search and try again from the book text.");
  }

  function changeQuery(value: string) {
    controller.current?.abort();
    setQuery(value);
    setSearching(false);
    setSearched(false);
    setResults([]);
    setError(null);
    setPickError(null);
    setLimited(false);
  }

  return (
    <dialog ref={dialog} className="book-search" aria-labelledby="book-search-title" onClose={onClose} onClick={closeOnBackdrop}>
      <header className="book-search__head">
        <h2 id="book-search-title">Find in this book</h2>
        <button type="button" className="icon-button" aria-label="Close search" onClick={() => dialog.current?.close()}><X size={20} aria-hidden /></button>
      </header>
      <form className="book-search__form" onSubmit={submit}>
        <label htmlFor="book-search-query">Search text</label>
        <div className="book-search__input-row">
          <input ref={input} id="book-search-query" type="search" value={query} minLength={2} maxLength={MAX_SEARCH_QUERY_LENGTH} required onChange={(event) => changeQuery(event.target.value)} />
          <button type="submit" className="button" disabled={searching || query.trim().length < 2}><Search size={18} aria-hidden /> Search</button>
        </div>
      </form>
      <div className="book-search__body">
        <p className="book-search__status" role="status">
          {searching ? `Searching chapters ${scanned} of ${book.chapters.length}...` : error ? "Search stopped." : searched ? limited ? `Showing first ${results.length} matches` : `${results.length} ${results.length === 1 ? "match" : "matches"}` : ""}
        </p>
        {error && <p className="inline-error" role="alert">{error} <button type="button" className="link-button" onClick={() => dialog.current?.querySelector("form")?.requestSubmit()}>Try again</button></p>}
        {pickError && <p className="inline-error" role="alert">{pickError}</p>}
        {searched && !searching && !error && results.length === 0 && <p className="book-search__empty">No passages found.</p>}
        {results.length > 0 && (
          <ol className="book-search__results">
            {results.map((result) => (
              <li key={`${result.chapterId}:${result.blockId}:${result.offset}`}>
                <button type="button" className="book-search__result" onClick={() => pick(result)}>
                  <span className="book-search__chapter">{result.chapterTitle}</span>
                  <span className="book-search__excerpt">
                    {result.excerpt.slice(0, result.matchStart)}
                    <mark>{result.excerpt.slice(result.matchStart, result.matchStart + result.matchLength)}</mark>
                    {result.excerpt.slice(result.matchStart + result.matchLength)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </dialog>
  );
}
