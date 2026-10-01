import { FileUp, Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Link, useLocation } from "wouter";
import type { BookSummary, BookUpdate } from "../shared/types.ts";
import { api } from "./api.ts";

// The same limits the server enforces, so the form never lets the reader type what would be refused.
const MAX_TITLE_CHARS = 200;
const MAX_AUTHOR_CHARS = 120;

type Mode = "view" | "edit" | "delete";
/** The one row that is being edited or asked to confirm its removal. */
type Active = { kind: "edit"; id: string } | { kind: "delete"; id: string; error: string | null };

function progressLabel(book: BookSummary): string {
  const hours = book.wordCount / 180 / 60;
  const length = hours >= 1 ? `about ${Math.round(hours)} h of reading` : `about ${Math.max(1, Math.round(hours * 60))} min of reading`;
  return `${book.chapterCount} chapters · ${length}`;
}

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

type EditFormProps = {
  book: BookSummary;
  saving: boolean;
  onSave: (update: BookUpdate) => Promise<void>;
  onClose: () => void;
};

function BookEditForm({ book, saving, onSave, onClose }: EditFormProps) {
  const titleId = useId();
  const authorId = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    titleInput.current?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || title.trim() === "") return;
    const update: BookUpdate = { title: title.trim(), author: author.trim() === "" ? null : author.trim() };
    if (update.title === book.title && update.author === book.author) {
      onClose();
      return;
    }
    setError(null);
    try {
      await onSave(update);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your changes could not be saved. Please try again.");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    // Escape also ends an input-method composition (Bangla typing); that must not close the form.
    if (event.key === "Escape" && !saving && !event.nativeEvent.isComposing) onClose();
  }

  return (
    <form
      className="shelf-edit"
      aria-label={`Edit ${book.title}`}
      onSubmit={(event) => void submit(event)}
      onKeyDown={handleKeyDown}
    >
      <div className="shelf-field">
        <label htmlFor={titleId}>Title</label>
        <input
          ref={titleInput}
          id={titleId}
          value={title}
          maxLength={MAX_TITLE_CHARS}
          required
          readOnly={saving}
          autoComplete="off"
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="shelf-field">
        <label htmlFor={authorId}>Author</label>
        <input
          id={authorId}
          value={author}
          maxLength={MAX_AUTHOR_CHARS}
          readOnly={saving}
          autoComplete="off"
          onChange={(event) => setAuthor(event.target.value)}
        />
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="shelf-edit-actions">
        <button type="submit" className="button" disabled={saving || title.trim() === ""}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" className="quiet-button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type BookRowProps = {
  book: BookSummary;
  mode: Mode;
  /** The book whose save or removal is in flight. Every other row waits, so only one request runs at a time. */
  pending: string | null;
  deleteError: string | null;
  onMode: (mode: Mode) => void;
  onSave: (id: string, update: BookUpdate) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
};

function BookRow({ book, mode, pending, deleteError, onMode, onSave, onRemove }: BookRowProps) {
  const editButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  // Set only when the reader closes this row's form or confirmation, so focus returns to the button that
  // opened it and is never pulled back when another row takes over.
  const returnFocusTo = useRef<"edit" | "remove" | null>(null);
  const busy = pending === book.id;

  useEffect(() => {
    if (mode === "delete") {
      // The safe choice gets focus; it is also where focus lands again if the removal fails.
      keepButton.current?.focus();
    } else if (mode === "view" && returnFocusTo.current) {
      (returnFocusTo.current === "edit" ? editButton : removeButton).current?.focus();
      returnFocusTo.current = null;
    }
  }, [mode, deleteError]);

  function close(opener: "edit" | "remove") {
    returnFocusTo.current = opener;
    onMode("view");
  }

  if (mode === "edit") {
    return (
      <li className="shelf-item">
        <BookEditForm
          book={book}
          saving={busy}
          onSave={(update) => onSave(book.id, update)}
          onClose={() => close("edit")}
        />
      </li>
    );
  }

  return (
    <li className="shelf-item">
      <Link href={`/book/${book.id}`} className="shelf-link">
        <span className="shelf-title">{book.title}</span>
        <span className="shelf-meta">
          {book.author ? `${book.author} · ` : ""}
          {progressLabel(book)}
        </span>
      </Link>
      {mode === "delete" ? (
        <span className="shelf-confirm">
          <button type="button" className="link-button danger" disabled={busy} onClick={() => void onRemove(book.id)}>
            {busy ? "Removing..." : "Remove"}
          </button>
          <button ref={keepButton} type="button" className="link-button" disabled={busy} onClick={() => close("remove")}>
            Keep
          </button>
        </span>
      ) : (
        <>
          <button
            ref={editButton}
            type="button"
            className="icon-button"
            aria-label={`Edit ${book.title}`}
            disabled={pending !== null}
            onClick={() => onMode("edit")}
          >
            <Pencil size={18} aria-hidden />
          </button>
          <button
            ref={removeButton}
            type="button"
            className="icon-button"
            aria-label={`Remove ${book.title}`}
            disabled={pending !== null}
            onClick={() => onMode("delete")}
          >
            <Trash2 size={18} aria-hidden />
          </button>
        </>
      )}
      {deleteError && (
        <p className="inline-error shelf-item-error" role="alert">
          {deleteError}
        </p>
      )}
    </li>
  );
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
      setError(err instanceof Error ? err.message : "That file could not be added.");
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
