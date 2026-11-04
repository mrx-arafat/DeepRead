import type { BookSummary, ReadingProgress, SessionInfo, StorageView } from "../../shared/types.ts";

/** What the library last knew of one reader's shelf. Null: not asked for yet. */
export type Shelf = { books: BookSummary[] | null; storage: StorageView | null };

// In memory only: a reload starts from nothing, and no reader's books are left in the browser for the next person.
const shelves = new Map<string, Shelf>();
const watchers = new Set<() => void>();
const NOTHING: Shelf = { books: null, storage: null };
// Who is signed in right now, as the session last told us.
let current: string | null = null;

/** The key a reader's shelf is kept under: the profile being read as (the one the admin reads as, while they do), or "single" without profiles. */
export function readerKey(info: SessionInfo | null): string {
  return info?.mode === "profiles" && info.session ? info.session.profile.id : "single";
}

/** The session says who is reading; a progress save started from here on belongs to them. */
export function setReader(key: string): void {
  current = key;
}

/** Who is reading, as the session last said; null before it has. */
export function currentReader(): string | null {
  return current;
}

/** Calls `watcher` whenever a shelf changes, until the returned function is called. */
export function watchShelves(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

/** The same object until the shelf changes, so a component can read it as it renders. */
export function readShelf(reader: string): Shelf {
  return shelves.get(reader) ?? NOTHING;
}

function keep(reader: string, shelf: Shelf): void {
  shelves.set(reader, shelf);
  for (const watcher of watchers) watcher();
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A book the server describes as the shelf already does keeps its object, and a list with nothing new changes nothing:
 * the library draws again only the rows whose books did change (most visits back from a book change one, or none).
 */
export function rememberBooks(reader: string, books: BookSummary[]): void {
  const before = readShelf(reader).books;
  const known = new Map(before?.map((book) => [book.id, book]));
  const kept = books.map((book) => {
    const old = known.get(book.id);
    return old && (old === book || same(old, book)) ? old : book;
  });
  if (before && kept.length === before.length && kept.every((book, at) => book === before[at])) return;
  keep(reader, { ...readShelf(reader), books: kept });
}

export function rememberStorage(reader: string, storage: StorageView): void {
  const before = readShelf(reader).storage;
  if (before && same(before, storage)) return;
  keep(reader, { ...readShelf(reader), storage });
}

function changeBooks(reader: string, change: (books: BookSummary[]) => BookSummary[]): void {
  const { books } = readShelf(reader);
  // Nothing cached: the next visit loads the whole shelf, so there is nothing to keep in step.
  if (books) rememberBooks(reader, change(books));
}

/** Changes one cached book, as the reader just did (a new title, a place saved). A field changed to undefined is removed, as the server leaves it out. */
export function patchBook(reader: string, id: string, changes: Partial<BookSummary>): void {
  changeBooks(reader, (books) =>
    books.map((book) => {
      if (book.id !== id) return book;
      const patched: Partial<BookSummary> = { ...book, ...changes };
      for (const [field, value] of Object.entries(changes)) if (value === undefined) delete patched[field as keyof BookSummary];
      return patched as BookSummary;
    }),
  );
}

export function dropBook(reader: string, id: string): void {
  changeBooks(reader, (books) => books.filter((book) => book.id !== id));
}

/** The newest book goes first, which is where the server lists it. */
export function addBook(reader: string, book: BookSummary): void {
  changeBooks(reader, (books) => [book, ...books]);
}

/**
 * Call when a progress save starts. What it returns files the place the server answered with on the shelf of the
 * reader who started it: the answer can come after someone else has signed in, and must not land on their shelf.
 */
export function progressFiler(): (bookId: string, progress: ReadingProgress) => void {
  const owner = current;
  return (bookId, progress) => {
    // The server's own answer, so the shelf says what the next list will say and nothing jumps when it arrives.
    if (owner) patchBook(owner, bookId, { progress });
  };
}

/** On sign out: the next person at this browser sees none of the books. */
export function forgetShelves(): void {
  shelves.clear();
  for (const watcher of watchers) watcher();
}
