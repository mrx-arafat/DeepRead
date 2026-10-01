import { FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { BookSummary, BookUpdate } from "../shared/types.ts";
import { api } from "./api.ts";
import { BookRow } from "./library/BookRow.tsx";
import type { Mode } from "./library/BookRow.tsx";
import { addFailure } from "./library/bookText.ts";

/** The one row that is being edited or asked to confirm its removal. */
type Active = { kind: "edit"; id: string } | { kind: "delete"; id: string; error: string | null };

/** The reader saves a book's notes in this browser, under deepread.notes.<bookId>.<chapterId>. */
function forgetNotes(bookId: string): void {
  const prefix = `deepread.notes.${bookId}`;
  try {
    // Collected first: removing a key while counting would make the next one slip past.
    const keys: string[] = [];
    for (let at = 0; at < localStorage.length; at += 1) {
      const key = localStorage.key(at);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch (error) {
    // The book is already gone; notes that could not be cleared are only wasted space.
    console.warn("could not remove the notes of a deleted book:", error);
  }
}

export function LibraryPage() {
  const [, navigate] = useLocation();
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [active, setActive] = useState<Active | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // `current` drops the answer of a request the reader has already replaced by pressing "Try again".
    let current = true;
    setLoadError(null);
    api
      .listBooks()
      .then((list) => current && setBooks(list))
      .catch((err: Error) => current && setLoadError(err.message));
    return () => {
      current = false;
    };
  }, [attempt]);

  async function add(file: File | undefined) {
    if (!file || uploading) return;
    setError(null);
    setUploading(file.name);
    try {
      const book = await api.uploadBook(file);
      navigate(`/book/${book.id}`);
    } catch (err) {
      setError(addFailure(file.name, err));
      setUploading(null);
    }
  }

  function show(id: string, mode: Mode) {
    setActive(mode === "view" ? null : mode === "edit" ? { kind: "edit", id } : { kind: "delete", id, error: null });
  }

  /** Rejects with the server's message, which the edit form shows and keeps itself open for. */
  async function save(id: string, update: BookUpdate): Promise<void> {
    setPending(id);
    try {
      const saved = await api.updateBook(id, update);
      setBooks((all) =>
        all?.map((book) => (book.id === id ? { ...book, title: saved.title, author: saved.author } : book)) ?? null,
      );
    } finally {
      setPending(null);
    }
  }

  async function remove(id: string): Promise<void> {
    setActive({ kind: "delete", id, error: null });
    setPending(id);
    try {
      await api.deleteBook(id);
      // Only now: if the request failed the book is still here, and so are its notes.
      forgetNotes(id);
      setBooks((all) => all?.filter((book) => book.id !== id) ?? null);
      setActive(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "That book could not be removed. Please try again.";
      setActive({ kind: "delete", id, error: message });
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="library">
      <header className="library-head">
        <h1>DeepRead</h1>
        <p>Read a book in English. Tap any word, select any passage, and get it explained right there.</p>
      </header>

      <div
        className="drop"
        data-dragging={dragging || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void add(event.dataTransfer.files[0]);
        }}
      >
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            void add(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {uploading ? (
          <p className="drop-busy" role="status">
            Reading <strong>{uploading}</strong> and splitting it into chapters. A long book can take a minute.
          </p>
        ) : (
          <>
            <button type="button" className="button" onClick={() => input.current?.click()}>
              <FileUp size={18} aria-hidden /> Add a book (PDF)
            </button>
            <span className="drop-hint">or drop a PDF here</span>
          </>
        )}
      </div>

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}

      {loadError && (
        <div className="library-retry">
          <p className="inline-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="quiet-button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {books?.length === 0 && <p className="library-empty">No books yet. Add a PDF to start reading.</p>}

      {books && books.length > 0 && (
        <section aria-label="Your books">
          <h2 className="library-section">Your books</h2>
          <ul className="shelf">
            {books.map((book) => {
              const mine = active?.id === book.id ? active : null;
              return (
                <BookRow
                  key={book.id}
                  book={book}
                  mode={mine?.kind ?? "view"}
                  pending={pending}
                  deleteError={mine?.kind === "delete" ? mine.error : null}
                  onMode={(mode) => show(book.id, mode)}
                  onSave={save}
                  onRemove={remove}
                />
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
