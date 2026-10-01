import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { Link } from "wouter";
import type { BookSummary, BookUpdate } from "../../shared/types.ts";
import { BookEditForm } from "./BookEditForm.tsx";
import { lengthLabel, shortTitle } from "./bookText.ts";

export type Mode = "view" | "edit" | "delete";

type Props = {
  book: BookSummary;
  mode: Mode;
  /** The book whose save or removal is in flight. Every other row waits, so only one request runs at a time. */
  pending: string | null;
  deleteError: string | null;
  /** True once, right after the book above this one was removed: focus lands on this row's link. */
  focusLink: boolean;
  onMode: (mode: Mode) => void;
  onSave: (id: string, update: BookUpdate) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
};

export function BookRow({ book, mode, pending, deleteError, focusLink, onMode, onSave, onRemove }: Props) {
  const questionId = useId();
  const link = useRef<HTMLAnchorElement>(null);
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

  useEffect(() => {
    if (focusLink) link.current?.focus();
  }, [focusLink]);

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

  function handleKeyDown(event: KeyboardEvent<HTMLLIElement>) {
    // Like the edit form: Escape backs out of the question, and does nothing while the removal is in flight.
    if (event.key === "Escape" && mode === "delete" && !busy) close("remove");
  }

  const { progress } = book;
  return (
    <li className="shelf-item" onKeyDown={handleKeyDown}>
      <Link ref={link} href={`/book/${book.id}`} className="shelf-link">
        <span className="shelf-title">{book.title}</span>
        {progress && (
          <span className="shelf-continue">
            <span className="shelf-continue-lead">
              Continue{progress.percent > 0 && ` · ${progress.percent}%`}
            </span>
            <span aria-hidden>·</span>
            <span className="shelf-continue-chapter">{progress.chapterTitle}</span>
          </span>
        )}
        <span className="shelf-meta">
          {book.author ? `${book.author} · ` : ""}
          {lengthLabel(book)}
        </span>
      </Link>
      {/* The icons stay where they are while the question is open, so the title keeps its line breaks. */}
      <button
        ref={editButton}
        type="button"
        className="icon-button"
        aria-label={`Edit ${book.title}`}
        title="Edit title and author"
        disabled={pending !== null || mode === "delete"}
        onClick={() => onMode("edit")}
      >
        <Pencil size={18} aria-hidden />
      </button>
      <button
        ref={removeButton}
        type="button"
        className="icon-button"
        aria-label={`Remove ${book.title}`}
        aria-expanded={mode === "delete"}
        disabled={pending !== null}
        onClick={() => (mode === "delete" ? close("remove") : onMode("delete"))}
      >
        <Trash2 size={18} aria-hidden />
      </button>
      {mode === "delete" && (
        <div className="shelf-confirm" role="group" aria-labelledby={questionId}>
          <p id={questionId}>Remove “{shortTitle(book.title)}” and the notes you made in it? This cannot be undone.</p>
          <div className="shelf-confirm-actions">
            <button type="button" className="link-button danger" disabled={busy} onClick={() => void onRemove(book.id)}>
              {busy ? "Removing..." : "Remove"}
            </button>
            <button ref={keepButton} type="button" className="link-button" disabled={busy} onClick={() => close("remove")}>
              Keep
            </button>
          </div>
        </div>
      )}
      {deleteError && (
        <p className="inline-error shelf-item-error" role="alert">
          {deleteError}
        </p>
      )}
    </li>
  );
}
