import { FileUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import type { BookSummary } from "../shared/types.ts";
import { api } from "./api.ts";

function progressLabel(book: BookSummary): string {
  const hours = book.wordCount / 180 / 60;
  const length = hours >= 1 ? `about ${Math.round(hours)} h of reading` : `about ${Math.max(1, Math.round(hours * 60))} min of reading`;
  return `${book.chapterCount} chapters · ${length}`;
}

export function LibraryPage() {
  const [, navigate] = useLocation();
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .listBooks()
      .then(setBooks)
      .catch((err: Error) => setError(err.message));
  }, []);

  async function add(file: File | undefined) {
    if (!file || uploading) return;
    setError(null);
    setUploading(file.name);
    try {
      const book = await api.uploadBook(file);
      navigate(`/book/${book.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be added.");
      setUploading(null);
    }
  }

  async function remove(id: string) {
    setConfirming(null);
    try {
      await api.deleteBook(id);
      setBooks((all) => all?.filter((book) => book.id !== id) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That book could not be removed.");
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

      {books && books.length > 0 && (
        <section aria-label="Your books">
          <h2 className="library-section">Your books</h2>
          <ul className="shelf">
            {books.map((book) => (
              <li key={book.id} className="shelf-item">
                <Link href={`/book/${book.id}`} className="shelf-link">
                  <span className="shelf-title">{book.title}</span>
                  <span className="shelf-meta">
                    {book.author ? `${book.author} · ` : ""}
                    {progressLabel(book)}
                  </span>
                </Link>
                {confirming === book.id ? (
                  <span className="shelf-confirm">
                    <button type="button" className="link-button danger" onClick={() => void remove(book.id)}>
                      Remove
                    </button>
                    <button type="button" className="link-button" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${book.title}`}
                    onClick={() => setConfirming(book.id)}
                  >
                    <Trash2 size={18} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
