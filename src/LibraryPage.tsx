import { FileUp, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { formatBytes } from "../shared/bytes.ts";
import { LANGUAGES } from "../shared/types.ts";
import type { BookSummary, BookUpdate, StorageUsage } from "../shared/types.ts";
import { api } from "./api.ts";
import { BookRow } from "./library/BookRow.tsx";
import type { Mode } from "./library/BookRow.tsx";
import { addFailure, latestRead, shortTitle } from "./library/bookText.ts";
import { ContinueCard } from "./library/ContinueCard.tsx";
import { useFileDrop } from "./library/useFileDrop.ts";
import { APP_NAME, useDocumentTitle } from "./pageTitle.ts";
import { usePrefs } from "./prefs.ts";
import { ProfileMenu } from "./profiles/ProfileMenu.tsx";
import { ReadingAs } from "./profiles/ReadingAs.tsx";
import { useSession } from "./profiles/session.tsx";
import { forgetHeldNotes, noteOwner } from "./reader/noteSync.ts";

const ADD_BUTTON = "add";

/** The one row that is being edited or asked to confirm its removal. */
type Active = { kind: "edit"; id: string } | { kind: "delete"; id: string; error: string | null };

export function LibraryPage() {
  const [, navigate] = useLocation();
  useDocumentTitle(`Your books - ${APP_NAME}`);
  const { lang } = usePrefs();
  const { info } = useSession();
  // Null with no profiles (nobody to show or switch) and while nobody is signed in (App shows the profiles then).
  const session = info?.mode === "profiles" ? info.session : null;
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The book the reader tried to add again, which the library already holds. */
  const [already, setAlready] = useState<{ id: string; title: string } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Where keyboard focus goes once a removed row is gone: a book's id, or "add". Set for one render.
  const [focusAfterRemoval, setFocusAfterRemoval] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const uploadingNow = useRef(false);
  const dragging = useFileDrop(onDrop, active?.kind !== "edit");

  useEffect(() => {
    // `current` drops the answer of a request the reader has already replaced by pressing "Try again".
    let current = true;
    setLoadError(null);
    api
      .listBooks()
      .then((list) => current && setBooks(list))
      .catch((err: Error) => current && setLoadError(err.message));
    // Only a line under the shelf: the shelf does not wait for it, and without it the shelf works the same.
    api
      .storage()
      .then((usage) => current && setStorage(usage))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (focusAfterRemoval === null) return;
    if (focusAfterRemoval === ADD_BUTTON) addButton.current?.focus();
    // The row that wanted focus has taken it by now (children's effects run first).
    setFocusAfterRemoval(null);
  }, [focusAfterRemoval]);

  function onDrop(files: FileList) {
    if (active?.kind === "edit") return;
    if (uploadingNow.current) {
      setError("A book is still being added. Drop it again when the upload finishes.");
      return;
    }
    if (files.length !== 1) {
      setError("Add one PDF at a time. No files were added; drop one PDF to try again.");
      return;
    }
    void add(files[0]);
  }

  async function add(file: File | undefined) {
    if (!file || uploadingNow.current) return;
    uploadingNow.current = true;
    setError(null);
    setAlready(null);
    setUploading(file.name);
    try {
      const { book, alreadyHad } = await api.uploadBook(file);
      if (alreadyHad) {
        // Stay on the shelf: the reader asked to add a book, not to open one, and nothing was added.
        setAlready({ id: book.id, title: book.title });
        setUploading(null);
        uploadingNow.current = false;
        return;
      }
      navigate(`/book/${book.id}`);
    } catch (err) {
      setError(addFailure(file.name, err));
      setUploading(null);
      uploadingNow.current = false;
    }
  }

  function show(id: string, mode: Mode) {
    setAlready(null);
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
      forgetHeldNotes(id, noteOwner(info));
      // The row the reader was on is about to vanish, and focus would fall to the page: hand it to a neighbour.
      const at = books?.findIndex((book) => book.id === id) ?? -1;
      setFocusAfterRemoval(books?.[at + 1]?.id ?? books?.[at - 1]?.id ?? ADD_BUTTON);
      setBooks((all) => all?.filter((book) => book.id !== id) ?? null);
      setActive(null);
      api.storage().then(setStorage, () => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "That book could not be removed. Please try again.";
      setActive({ kind: "delete", id, error: message });
    } finally {
      setPending(null);
    }
  }

  const empty = books?.length === 0;
  const resume = books && latestRead(books);

  return (
    <>
      {session?.impersonatedBy && <ReadingAs session={session} admin={session.impersonatedBy} />}
      <main className="library" data-dragging={dragging || undefined}>
        {session && <ProfileMenu session={session} />}
        {/* Held back until the list has loaded: a first visit turns this into the welcome below, and showing the add button first would make it jump. */}
        <div className="library-top" data-empty={empty || undefined} data-waiting={(books === null && !loadError) || undefined}>
          <header className="library-head">
            <h1>DeepRead</h1>
            {empty && (
              <>
                <p>Read a book in English. Tap any word, select any passage, and get it explained right there.</p>
                <p>Meanings in {LANGUAGES[lang]} and simple English. Works with PDFs whose text you can select, not scans.</p>
              </>
            )}
          </header>

          <div className="drop" data-dragging={dragging || undefined}>
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
            {empty && (
              <span className="drop-shelf" aria-hidden>
                <span />
                <span />
                <span />
                <span />
                <span />
              </span>
            )}
            <div className="drop-body">
              {empty && !uploading && (
                <>
                  <p className="library-empty">No books yet. Add a PDF to start reading.</p>
                  <p className="library-empty-more">
                    Each book gets a cover here, and the one you read last waits at the top so you can pick up where you stopped.
                  </p>
                </>
              )}
              {uploading ? (
                <div className="drop-busy" role="status">
                  <LoaderCircle className="drop-spinner" size={20} aria-hidden />
                  <span className="drop-busy-text">
                    <strong className="drop-busy-name">Reading {uploading}</strong>
                    <span>A long book can take a minute.</span>
                  </span>
                </div>
              ) : (
                <div className="drop-actions">
                  <button ref={addButton} type="button" className="button" onClick={() => input.current?.click()}>
                    <FileUp size={18} aria-hidden /> Add a book (PDF)
                  </button>
                  <span className="drop-hint">
                    {dragging ? "Drop one PDF to add it" : empty ? "or drop one PDF here" : "or drop one PDF anywhere"}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}

        {already && (
          <p className="inline-notice" role="status">
            “{shortTitle(already.title)}” is already in your library, so nothing was added.{" "}
            <Link href={`/book/${already.id}`}>Open it</Link>
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

        {resume && <ContinueCard book={resume} />}

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
                    focusLink={focusAfterRemoval === book.id}
                    onMode={(mode) => show(book.id, mode)}
                    onSave={save}
                    onRemove={remove}
                  />
                );
              })}
            </ul>
            {storage && (
              <p className="library-storage">
                Your books take {formatBytes(storage.used)}
                {/* The limit is shared, so with other readers it is set against everyone's books, not just these. */}
                {storage.total !== storage.used && `; everyone's together take ${formatBytes(storage.total)}`}
                {storage.limit !== null && ` of ${formatBytes(storage.limit)}`},{" "}
                {storage.where === "r2" ? "kept in Cloudflare R2" : "kept on this computer"}.
              </p>
            )}
          </section>
        )}
      </main>
    </>
  );
}
