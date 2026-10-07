import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { Link } from "wouter";
import type { BookSummary, BookUpdate, ReadingStatus } from "../../shared/types.ts";
import { BookEditDialog } from "./BookEditDialog.tsx";
import { BookMenu } from "./BookMenu.tsx";
import { readingNote, shortTitle } from "./bookText.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { Cover } from "./Cover.tsx";
import { ShareDialog } from "./ShareDialog.tsx";

export type Mode = "view" | "edit" | "delete" | "share";

type Props = {
  book: BookSummary;
  mode: Mode;
  /** The book whose save or removal is in flight. Every other row waits, so only one request runs at a time. */
  pending: string | null;
  deleteError: string | null;
  /** True once, right after the book next to this one was removed: focus lands on this book's link. */
  focusLink: boolean;
  /** True once, right after this book moved between the Pinned and Your books lists: focus lands on its "More actions" button. */
  focusMenu: boolean;
  /** Who is reading, with profiles on: they may share their own books with the others. Null without profiles. */
  readerId: string | null;
  onMode: (mode: Mode) => void;
  onPin: () => void;
  onStatus: (status: ReadingStatus) => void;
  onSave: (id: string, update: BookUpdate) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
};

/** One book on the shelf: its cover (a link to the book), how far the reader is, and what else can be done to it. */
export function BookRow({ book, mode, pending, deleteError, focusLink, focusMenu, readerId, onMode, onPin, onStatus, onSave, onRemove }: Props) {
  const questionId = useId();
  const link = useRef<HTMLAnchorElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  // Set only when the reader closes this book's form or question, so focus returns to the "more" button that
  // opened it and is never pulled back when another book takes over.
  const returnFocus = useRef(false);
  const busy = pending === book.id;

  useEffect(() => {
    if (mode === "delete") {
      // The safe choice gets focus; it is also where focus lands again if the removal fails.
      keepButton.current?.focus();
    } else if (mode === "view" && returnFocus.current) {
      menuButton.current?.focus();
      returnFocus.current = false;
    }
  }, [mode, deleteError]);

  useEffect(() => {
    if (focusLink) link.current?.focus();
  }, [focusLink]);

  useEffect(() => {
    if (focusMenu) menuButton.current?.focus();
  }, [focusMenu]);

  function close() {
    returnFocus.current = true;
    onMode("view");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLLIElement>) {
    // Like the edit form: Escape backs out of the question, and does nothing while the removal is in flight.
    if (event.key === "Escape" && mode === "delete" && !busy) close();
  }

  const note = readingNote(book);
  const { sharedBy } = book;
  return (
    <li className="shelf-item" data-state={note.state} data-new={(book.progress === null && book.readingStatus === "reading") || undefined} onKeyDown={handleKeyDown}>
      {/* The tooltip carries the whole title: a long one is cut short on the cover. */}
      <Link ref={link} href={`/book/${book.id}`} className="shelf-link" title={book.title}>
        <Cover book={book} />
      </Link>
      {/* Always there, so books that have not been started line up with the ones that have. */}
      <span className="read-bar" aria-hidden data-empty={book.progress === null || undefined}>
        <span style={{ width: `${note.percent}%` }} />
      </span>
      {mode === "delete" ? (
        <div className="shelf-confirm" role="group" aria-labelledby={questionId}>
          <p id={questionId}>
            {sharedBy
              ? `Take “${shortTitle(book.title)}” off your shelf? ${sharedBy.name} keeps the book, and if they share it again your notes and place come back.`
              : `Remove “${shortTitle(book.title)}” and the notes you made in it? This cannot be undone.`}
          </p>
          <div className="shelf-confirm-actions">
            <button type="button" className="link-button danger" disabled={busy} onClick={() => void onRemove(book.id)}>
              {busy ? "Removing..." : "Remove"}
            </button>
            <button ref={keepButton} type="button" className="link-button" disabled={busy} onClick={close}>
              Keep
            </button>
          </div>
        </div>
      ) : (
        <div className="shelf-info">
          <p className="shelf-meta">
            <span className="shelf-meta-lead">{note.lead}</span>
            {note.detail && <span>{note.detail}</span>}
            {/* The chapter is on the Continue card for the book read last; every book tells a screen reader where it stopped. */}
            {book.progress && <span className="visually-hidden">Stopped in {book.progress.chapterTitle}</span>}
            {sharedBy && (
              <span className="shelf-from">
                <Avatar profile={sharedBy} size={18} />
                <span>
                  <span className="visually-hidden">{sharedBy.name} shared this book with you. </span>
                  <span aria-hidden>From {sharedBy.name}</span>
                </span>
              </span>
            )}
          </p>
          <BookMenu
            title={book.title}
            disabled={pending !== null}
            triggerRef={menuButton}
            pinned={book.pinnedAt !== undefined}
            onPin={onPin}
            shared={sharedBy !== undefined}
            onEdit={sharedBy ? undefined : () => onMode("edit")}
            onShare={sharedBy || readerId === null ? undefined : () => onMode("share")}
            onRemove={() => onMode("delete")}
          />
        </div>
      )}
      {mode !== "delete" && (
        <div className="shelf-status">
          <label className="visually-hidden" htmlFor={`status-${book.id}`}>Reading status for {book.title}</label>
          <select id={`status-${book.id}`} value={book.readingStatus} disabled={pending !== null} onChange={(event) => onStatus(event.target.value as ReadingStatus)}>
            <option value="saved">Saved for later</option>
            <option value="reading">Reading</option>
            <option value="finished">Finished</option>
          </select>
        </div>
      )}
      {deleteError && (
        <p className="inline-error shelf-item-error" role="alert">
          {deleteError}
        </p>
      )}
      {mode === "edit" && (
        <BookEditDialog book={book} saving={busy} onSave={(update) => onSave(book.id, update)} onClose={close} />
      )}
      {mode === "share" && readerId !== null && <ShareDialog book={book} readerId={readerId} onClose={close} />}
    </li>
  );
}
