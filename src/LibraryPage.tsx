import { ArrowRight, BookOpen, Bookmark, FileUp, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "wouter";
import { formatBytes } from "../shared/bytes.ts";
import { LANGUAGES } from "../shared/types.ts";
import type { BookSummary, BookUpdate, ReadingStatus } from "../shared/types.ts";
import { api } from "./api.ts";
import { BookRow } from "./library/BookRow.tsx";
import type { Mode } from "./library/BookRow.tsx";
import { addFailure, filterBooks, latestRead, shortTitle, splitPinned } from "./library/bookText.ts";
import type { StartedBook } from "./library/bookText.ts";
import { Cover } from "./library/Cover.tsx";
import { ContinueCard } from "./library/ContinueCard.tsx";
import { ResumeContext } from "./library/ResumeContext.tsx";
import { addBook, dropBook, patchBook, readerKey, readShelf, rememberBooks, rememberStorage, watchShelves } from "./library/shelfCache.ts";
import { useFileDrop } from "./library/useFileDrop.ts";
import { APP_NAME, useDocumentTitle } from "./pageTitle.ts";
import { usePrefs } from "./prefs.ts";
import { ProfileMenu } from "./profiles/ProfileMenu.tsx";
import { ReadingAs } from "./profiles/ReadingAs.tsx";
import { useSession } from "./profiles/session.tsx";
import { forgetHeldNotes, noteOwner } from "./reader/noteSync.ts";

const ADD_BUTTON = "add";
const STATUS_FILTERS: { value: ReadingStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "reading", label: "Reading" },
  { value: "saved", label: "Saved for later" },
  { value: "finished", label: "Finished" },
];

/** The one row that is being edited or asked to confirm its removal. */
type Active = { kind: "edit" | "share"; id: string } | { kind: "delete"; id: string; error: string | null };

export function LibraryPage() {
  const [, navigate] = useLocation();
  useDocumentTitle(`Your books - ${APP_NAME}`);
  const { lang } = usePrefs();
  const { info } = useSession();
  // Null with no profiles (nobody to show or switch) and while nobody is signed in (App shows the profiles then).
  const session = info?.mode === "profiles" ? info.session : null;
  const reader = readerKey(info);
  // Coming back paints the shelf as it was last time, while the request below brings it up to date. It is read from the
  // cache, not kept in state, so a progress save that is still on its way as this page opens lands on it as well.
  const { books, storage } = useSyncExternalStore(watchShelves, () => readShelf(reader));
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "title" | "progress">("recent");
  const [statusFilter, setStatusFilter] = useState<ReadingStatus | "all">("all");
  const [focusFilterAfterStatus, setFocusFilterAfterStatus] = useState(false);
  const [context, setContext] = useState<{ book: StartedBook; reader: string } | null>(null);
  const searchedBooks = useMemo(() => filterBooks(books ?? [], query), [books, query]);
  const visibleBooks = useMemo(() => {
    const filtered = filterBooks(searchedBooks, "", statusFilter);
    if (sort === "title") filtered.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "progress") filtered.sort((a, b) => (b.progress?.percent ?? 0) - (a.progress?.percent ?? 0));
    return filtered;
  }, [searchedBooks, statusFilter, sort]);
  // Pinned books get a shelf of their own above the others, which stay in the order the server lists them.
  const { pinned, rest } = useMemo(() => splitPinned(visibleBooks), [visibleBooks]);
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
  // The book whose row just moved between the Pinned and Your books lists: focus goes to its "More actions" button. Set for one render.
  const [focusMenuOf, setFocusMenuOf] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const selectedFilter = useRef<HTMLButtonElement>(null);
  const uploadingNow = useRef(false);
  // A file dropped on a dialog over the shelf is not meant for the shelf.
  const showingContext = context?.reader === reader && books?.some((book) => book.id === context.book.id) === true;
  const inDialog = active?.kind === "edit" || active?.kind === "share" || showingContext;
  const dragging = useFileDrop(onDrop, !inDialog);

  useEffect(() => {
    // `current` drops the answer of a request the reader has already replaced by pressing "Try again".
    let current = true;
    setLoadError(null);
    api
      .listBooks()
      .then((list) => current && rememberBooks(reader, list))
      .catch((err: Error) => current && setLoadError(err.message));
    // Only a line under the shelf: the shelf does not wait for it, and without it the shelf works the same.
    api
      .storage()
      .then((usage) => current && rememberStorage(reader, usage))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [attempt, reader]);

  useEffect(() => {
    if (focusAfterRemoval === null) return;
    if (focusAfterRemoval === ADD_BUTTON) addButton.current?.focus();
    // The row that wanted focus has taken it by now (children's effects run first).
    setFocusAfterRemoval(null);
  }, [focusAfterRemoval]);

  useEffect(() => {
    // The row that wanted focus has taken it by now (children's effects run first).
    if (focusMenuOf !== null) setFocusMenuOf(null);
  }, [focusMenuOf]);

  useEffect(() => {
    if (!focusFilterAfterStatus) return;
    selectedFilter.current?.focus();
    setFocusFilterAfterStatus(false);
  }, [focusFilterAfterStatus, visibleBooks]);

  function onDrop(files: FileList) {
    if (inDialog) return;
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
      // The shelf the reader comes back to from this book already has it.
      addBook(reader, book);
      navigate(`/book/${book.id}`);
    } catch (err) {
      setError(addFailure(file.name, err));
      setUploading(null);
      uploadingNow.current = false;
    }
  }

  function show(id: string, mode: Mode) {
    setAlready(null);
    setActive(mode === "view" ? null : mode === "delete" ? { kind: "delete", id, error: null } : { kind: mode, id });
  }

  /** Rejects with the server's message, which the edit form shows and keeps itself open for. */
  async function save(id: string, update: BookUpdate): Promise<void> {
    setPending(id);
    try {
      const saved = await api.updateBook(id, update);
      patchBook(reader, id, { title: saved.title, author: saved.author });
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
      // The row the reader was on is about to vanish, and focus would fall to the page: hand it to a neighbour, in the order the shelf shows.
      const shown = [...pinned, ...rest];
      const at = shown.findIndex((book) => book.id === id);
      setFocusAfterRemoval(shown[at + 1]?.id ?? shown[at - 1]?.id ?? ADD_BUTTON);
      dropBook(reader, id);
      setActive(null);
      api.storage().then((usage) => rememberStorage(reader, usage), () => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "That book could not be removed. Please try again.";
      setActive({ kind: "delete", id, error: message });
    } finally {
      setPending(null);
    }
  }

  /** Moves the book at once and tells the server after; if the server refuses, the book goes back where it was. */
  async function togglePin(book: BookSummary): Promise<void> {
    const { id } = book;
    const before = book.pinnedAt;
    const pinning = before === undefined;
    const guess = pinning ? new Date().toISOString() : undefined;
    // Whether the shelf still shows what this request put there: the reader may have changed their mind while it was on its way.
    const unchanged = () => readShelf(reader).books?.find((each) => each.id === id)?.pinnedAt === guess;
    // The row moves to the other list and starts again there, and focus would fall to the page: hand it to the book's "More actions" button.
    function move(pinnedAt: string | undefined) {
      setFocusMenuOf(id);
      patchBook(reader, id, { pinnedAt });
    }
    setError(null);
    move(guess);
    try {
      if (pinning) {
        // The server's own time, so the order on the shelf is the one the next list will give.
        const pinnedAt = await api.pinBook(id);
        if (unchanged()) patchBook(reader, id, { pinnedAt });
      } else {
        await api.unpinBook(id);
      }
    } catch {
      if (!unchanged()) return;
      move(before);
      setError(`That book could not be ${pinning ? "pinned" : "unpinned"}. Please try again.`);
    }
  }

  async function setReadingStatus(book: BookSummary, status: ReadingStatus): Promise<void> {
    if (book.readingStatus === status) return;
    const { id, readingStatus: before } = book;
    const unchanged = () => readShelf(reader).books?.find((each) => each.id === id)?.readingStatus === status;
    setError(null);
    setPending(id);
    if (statusFilter !== "all" && statusFilter !== status) setFocusFilterAfterStatus(true);
    patchBook(reader, id, { readingStatus: status });
    try {
      const saved = await api.setReadingStatus(id, status);
      if (unchanged()) patchBook(reader, id, { readingStatus: saved });
    } catch {
      if (unchanged()) patchBook(reader, id, { readingStatus: before });
      setError(`The reading status for "${shortTitle(book.title)}" could not be saved. Please try again.`);
    } finally {
      setPending(null);
    }
  }

  const empty = books?.length === 0;
  const resume = books && latestRead(books);
  const upNext = books?.find((book) => book.readingStatus === "saved" && book.id !== resume?.id);
  const finishedCount = books?.filter((book) => book.readingStatus === "finished").length ?? 0;

  function row(book: BookSummary) {
    const mine = active?.id === book.id ? active : null;
    return (
      <BookRow
        key={book.id}
        book={book}
        mode={mine?.kind ?? "view"}
        pending={pending}
        deleteError={mine?.kind === "delete" ? mine.error : null}
        focusLink={focusAfterRemoval === book.id}
        focusMenu={focusMenuOf === book.id}
        readerId={session?.profile.id ?? null}
        onMode={(mode) => show(book.id, mode)}
        onPin={() => void togglePin(book)}
        onStatus={(status) => void setReadingStatus(book, status)}
        onSave={save}
        onRemove={remove}
      />
    );
  }

  const storageLine = storage && (
    <p className="library-storage">
      {/* Only this reader's books: the limit is enforced on upload, and what others keep is not their business. */}
      Your books take {formatBytes(storage.used)},{" "}
      {storage.where === "r2" ? "kept in Cloudflare R2" : "kept on this computer"}.
    </p>
  );

  return (
    <>
      {session?.impersonatedBy && <ReadingAs session={session} admin={session.impersonatedBy} />}
      <main className="library" data-dragging={dragging || undefined}>
        {session && <ProfileMenu session={session} />}
        {/* Held back until the list has loaded: a first visit turns this into the welcome below, and showing the add button first would make it jump. */}
        <div className="library-top" data-empty={empty || undefined} data-waiting={(books === null && !loadError) || undefined}>
          <header className="library-head">
            <h1><BookOpen size={25} strokeWidth={1.6} aria-hidden /> DeepRead</h1>
            {books && !empty && <p className="library-subtitle">A home for curious minds.</p>}
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

        {books && !empty && !query.trim() && (statusFilter === "all" || statusFilter === "reading") && (
          <section className="library-discover" aria-labelledby="library-welcome">
            <div className="library-welcome">
              <div>
                <p className="library-eyebrow">THE READING ROOM</p>
                <h2 id="library-welcome">A little time. <em>A good book.</em></h2>
                <p>Pick up a thought where you left it, or discover your next one.</p>
              </div>
              <p className="library-tally"><strong>{books.length}</strong> {books.length === 1 ? "book" : "books"} on your shelf<span>{finishedCount} finished</span></p>
            </div>
            <div className="library-spotlight" data-paired={Boolean(resume && upNext && statusFilter === "all") || undefined}>
              {resume && <ContinueCard book={resume} onContext={() => setContext({ book: resume, reader })} />}
              {upNext && statusFilter === "all" && (
                <section className="library-up-next" aria-labelledby="up-next-heading">
                  <p className="library-eyebrow"><Bookmark size={15} aria-hidden /> SAVED FOR A QUIET MOMENT</p>
                  <h3 id="up-next-heading">Up next</h3>
                  <div className="up-next-book">
                    <div className="up-next-cover" aria-hidden><Cover book={upNext} /></div>
                    <div><h4>{upNext.title}</h4>{upNext.author && <p>{upNext.author}</p>}</div>
                  </div>
                  <Link className="up-next-link" href={`/book/${upNext.id}`} aria-label={`Open ${upNext.title}`}>Open book <ArrowRight size={18} aria-hidden /></Link>
                </section>
              )}
            </div>
          </section>
        )}

        {books && books.length > 1 && (
          <section className="library-toolbar" aria-label="Browse your library">
            <div className="library-toolbar-heading"><h2>Your collection</h2><span>{books.length} books</span></div>
            <div className="library-search">
              <label className="visually-hidden" htmlFor="library-search">Find a book</label>
              <div className="library-search-field">
                <Search size={18} aria-hidden />
                <input id="library-search" type="search" placeholder="Search by title or author…" value={query} onChange={(event) => setQuery(event.target.value)} />
                {query && <button type="button" className="icon-button" aria-label="Clear book search" title="Clear book search" onClick={() => setQuery("")}><X size={18} aria-hidden /></button>}
              </div>
              {query.trim() && <p className="library-search-count" role="status">{visibleBooks.length} {visibleBooks.length === 1 ? "book" : "books"} found</p>}
            </div>
            <div className="library-status-filters" role="group" aria-label="Filter by reading status">
              {STATUS_FILTERS.map(({ value, label }) => (
                <button
                  key={value}
                  ref={statusFilter === value ? selectedFilter : undefined}
                  type="button"
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {label} <span>{value === "all" ? searchedBooks.length : searchedBooks.filter((book) => book.readingStatus === value).length}</span>
                </button>
              ))}
            </div>
            <div className="library-sort">
              <label htmlFor="library-sort">Sort by</label>
              <select id="library-sort" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
                <option value="recent">Recently added</option>
                <option value="title">Title A–Z</option>
                <option value="progress">Reading progress</option>
              </select>
            </div>
          </section>
        )}

        {books && books.length > 0 && visibleBooks.length === 0 && (
          <div className="library-no-results">
            <p role="status">{query.trim() ? `No ${statusFilter === "all" ? "" : STATUS_FILTERS.find((item) => item.value === statusFilter)?.label.toLowerCase() + " "}books match "${query.trim()}".` : `No books marked ${STATUS_FILTERS.find((item) => item.value === statusFilter)?.label.toLowerCase()}.`}</p>
            <button type="button" className="quiet-button" onClick={() => { setQuery(""); setStatusFilter("all"); }}><X size={16} aria-hidden /> Show all books</button>
          </div>
        )}

        {pinned.length > 0 && (
          <section aria-label="Pinned">
            <h2 className="library-section">Pinned</h2>
            <ul className="shelf">{pinned.map(row)}</ul>
            {rest.length === 0 && storageLine}
          </section>
        )}

        {rest.length > 0 && (
          <section aria-label="Your books">
            <h2 className="library-section">Your books</h2>
            <ul className="shelf">{rest.map(row)}</ul>
            {storageLine}
          </section>
        )}
        {showingContext && context && <ResumeContext key={`${reader}:${context.book.id}`} book={context.book} onClose={() => setContext(null)} />}
      </main>
    </>
  );
}
