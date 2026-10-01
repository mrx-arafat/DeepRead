import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { BookSummary, BookUpdate } from "../../shared/types.ts";

// The same limits the server enforces, so the form never lets the reader type what would be refused.
const MAX_TITLE_CHARS = 200;
const MAX_AUTHOR_CHARS = 120;

type Props = {
  book: BookSummary;
  saving: boolean;
  onSave: (update: BookUpdate) => Promise<void>;
  onClose: () => void;
};

export function BookEditForm({ book, saving, onSave, onClose }: Props) {
  const titleId = useId();
  const titleErrorId = useId();
  const authorId = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [error, setError] = useState<string | null>(null);
  const emptyTitle = title.trim() === "";

  useEffect(() => {
    titleInput.current?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (emptyTitle) {
      // The reason is already on screen under the field; bring the reader back to it.
      titleInput.current?.focus();
      return;
    }
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
      // The browser's own "fill out this field" bubble would stand in for the sentence shown under the field.
      noValidate
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
          aria-required
          aria-invalid={emptyTitle}
          aria-describedby={emptyTitle ? titleErrorId : undefined}
          readOnly={saving}
          autoComplete="off"
          onChange={(event) => setTitle(event.target.value)}
        />
        {emptyTitle && (
          <p id={titleErrorId} className="inline-error" role="alert">
            The title cannot be empty. Type a title for this book.
          </p>
        )}
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
        <button type="submit" className="button" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" className="quiet-button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
