// The books, kept in an ObjectStore (storage.ts): the data folder on this computer, or an R2 bucket.
// Each book is books/<id>/{source.pdf, book.json, meta.json, notes.json, cache/<key>.json}, plus cover.webp when page 1
// is a cover, and translations/<lang>/<chapter id>.json for each chapter translated (chapter-translation.ts).
// meta.json is written last and removed first, so a book exists exactly while its meta.json does: a crash in between
// leaves files no listing shows, and the next start clears them away. meta.json carries everything the list view
// needs, so listing never opens book.json. Once read, the list of books and each meta.json are kept in
// memory, so listing again asks the store nothing. pins.json, at the root of the store, says when the reader pinned each
// book to the top of the library, and is kept in memory the same way.
// Uploads are parsed from <dataDir>/tmp on this computer whatever the store, because the parser reads a file.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatBytes } from "../shared/bytes.ts";
import { applyNoteChange } from "../shared/notes.ts";
import type { NoteChange } from "../shared/notes.ts";
import type {
  BookDetail,
  BookSummary,
  BookUpdate,
  Chapter,
  ChapterSummary,
  LangCode,
  Note,
  ParsedBook,
  ReadingProgress,
  ReadingStatus,
  StorageUsage,
} from "../shared/types.ts";
import type { CoverImage } from "./cover.ts";
import type { RenderCover } from "./deps.ts";
import { isRecord } from "./http.ts";
import { describePosition } from "./progress.ts";
import { createLocalStore } from "./storage.ts";
import type { ByteRange, ObjectStore, StoredObject } from "./storage.ts";

// Ids are a lowercase slug plus a hash. Anything else cannot be a book, so it never reaches the store.
const BOOK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CACHE_KEY = /^[0-9a-f]{64}$/;
// A chapter id the parser makes ("c12") names its translation's file; anything else goes by its hash, which stays in the folder.
const PLAIN_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_SLUG = 48;
const HASH_CHARS = 8;
const LONG_HASH_CHARS = 16;
const PARSED_BOOKS_KEPT = 4;
// The cover is WebP; JPEG only where this computer's image library cannot write WebP.
const COVER_FILES: Record<CoverImage["type"], string> = { "image/webp": "cover.webp", "image/jpeg": "cover.jpg" };
// Not a book id (ids have no spaces), so adding books queues apart from any one book's work.
const ADDING = "adding books";
const META_KEY = /^books\/([^/]+)\/meta\.json$/;
const PINS_KEY = "pins.json";
// Not a book id either, so pin changes queue apart from any one book's work.
const PINNING = "pinning books";

/** The key an answer is cached under: a SHA-256 in hex. */
export const isCacheKey = (key: string): boolean => CACHE_KEY.test(key);

export function isBookId(id: string): boolean {
  return id.length <= 96 && BOOK_ID.test(id);
}

/** The books in a listing of books/: the folders named like a book that hold a meta.json. */
const bookIdsIn = (objects: StoredObject[]): Set<string> =>
  new Set(objects.map((object) => META_KEY.exec(object.key)?.[1]).filter((id): id is string => id !== undefined && isBookId(id)));

/** The pins pins.json holds, by book id: when each was pinned. A file that is not that is damaged, never taken for empty. */
function parsePins(data: Buffer | null): ReadonlyMap<string, string> {
  let parsed: unknown = {};
  if (data) {
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      parsed = null;
    }
  }
  if (!isRecord(parsed) || !Object.values(parsed).every((at) => typeof at === "string")) {
    // Treated as empty, the next pin would write over everyone's.
    throw new Error(`${PINS_KEY} is damaged, so the pinned books cannot be read. Restore it from a copy, or mend it by hand.`);
  }
  return new Map(Object.entries(parsed as Record<string, string>));
}

/** `fallback` names what has no Latin letters at all (a Bangla or Arabic title). */
export function slugify(title: string, fallback = "book"): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  // Titles with no Latin letters (Bangla, Arabic...) still get a usable id.
  return slug === "" ? fallback : slug;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function chapterWords(chapter: Chapter): number {
  return chapter.blocks.reduce((sum, block) => sum + countWords(block.text), 0);
}

/** What meta.json holds: the list-view summary plus what dedupe and the detail view need. */
type BookMeta = Omit<BookSummary, "hasCover" | "readingStatus"> & {
  /** Absent for books stored before shelf status was introduced. */
  readingStatus?: ReadingStatus;
  sha256: string;
  chapterWordCounts: Record<string, number>;
  /** Whether page 1 is the book's cover. Absent in books stored before covers were kept: not looked at yet. */
  cover?: boolean;
};

/** Progress saved before it carried a chapter title and a percentage: those are filled in from the book. */
function lacksDetails(meta: BookMeta): boolean {
  return meta.progress !== null && typeof meta.progress.percent !== "number";
}

function withDetails(meta: BookMeta, book: ParsedBook): BookMeta {
  const { progress } = meta;
  if (!progress || !lacksDetails(meta)) return meta;
  const where = describePosition(book, meta.chapterWordCounts, progress.chapterId, progress.blockId, progress.offset);
  // A spot that is no longer in the book cannot be named, so the library shows the book as unstarted.
  return { ...meta, progress: where && { ...progress, ...where } };
}

/** Adding a book would take the library past its storage limit. The message says how full it is. */
export class StorageFullError extends Error {
  readonly usage: StorageUsage;
  readonly needed: number;

  constructor(usage: StorageUsage, needed: number) {
    // With profiles the limit is shared, so other readers' books can be what fills it. The message says so without
    // saying how much they keep: a reader is told their own books, never anyone else's.
    const yours = `your books take ${formatBytes(usage.used)}`;
    const room =
      usage.total > usage.used ? `the space everyone shares is full (${yours})` : `${yours} of the ${formatBytes(usage.limit ?? 0)} they may use`;
    super(`There is no room for it: ${room}, and this one needs ${formatBytes(needed)}. Remove a book to make room.`);
    this.name = "StorageFullError";
    this.usage = usage;
    this.needed = needed;
  }
}

/** The library was closed (its profile removed) while a request still held it, so it takes no more changes. */
export class LibraryClosedError extends Error {
  constructor() {
    super("This library is closed: its profile was removed.");
    this.name = "LibraryClosedError";
  }
}

export type NewBook = {
  /** A finished upload on this computer; it is moved or copied into the store. */
  uploadPath: string;
  sha256: string;
  parsed: ParsedBook;
  /** Page 1 of the PDF when it is a cover. */
  cover: CoverImage | null;
};

/** A book's PDF: its size, and its bytes when asked for. `stream` is null if the book went in the meantime. */
export type StoredPdf = {
  size: number;
  stream(range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
};

/** One limit for several libraries: each profile's books count against the room everyone shares. */
export type SharedLimit = {
  /** Bytes the books of every library sharing the limit take together. */
  total(): Promise<number>;
  /** Runs `work` once no library sharing the limit is adding a book, so two cannot both fit in the room left for one. */
  adding<T>(work: () => Promise<T>): Promise<T>;
};

export type LibraryOptions = {
  /** Where the books are kept. The data folder when not given. */
  store?: ObjectStore;
  /** The most bytes the books may take; null or absent for no limit. */
  limit?: number | null;
  /**
   * The folder on this computer that uploads pass through, <dataDir>/tmp when not given. It is emptied on first use, so
   * two libraries must never share one: each would delete the other's upload in flight.
   */
  tempDir?: string;
  /** Absent: this library has the limit to itself. */
  shared?: SharedLimit;
};

export type Library = {
  /**
   * Where the next upload should be written, on this computer.
   * The file is named `title`, which is what the parser calls a book whose PDF has no title of its own.
   */
  newUploadPath(title: string): Promise<string>;
  /** Removes an upload that was not added to the library. */
  discardUpload(uploadPath: string): Promise<void>;
  list(): Promise<BookSummary[]>;
  findBySha(sha256: string): Promise<string | null>;
  /** Throws StorageFullError when `bytes` more would take the books past their limit. */
  assertRoom(bytes: number): Promise<void>;
  /** Throws StorageFullError when there is no room for it. */
  add(book: NewBook): Promise<{ id: string; created: boolean }>;
  detail(id: string): Promise<BookDetail | null>;
  /** The parsed book as the reader sees it: with the title and author the reader last set. */
  book(id: string): Promise<ParsedBook | null>;
  pdf(id: string): Promise<StoredPdf | null>;
  /** Null when the book has no cover of its own, or has not been looked at yet. */
  cover(id: string): Promise<CoverImage | null>;
  /**
   * Books stored before covers were kept have never been looked at: finds theirs, one book at a time, and notes the
   * books without one so they are not looked at again. Never rejects.
   */
  addMissingCovers(renderCover: RenderCover): Promise<void>;
  setProgress(id: string, chapterId: string, blockId: string, offset: number): Promise<ReadingProgress | null>;
  /** A manual correction; saving reading progress does not change this. */
  setReadingStatus(id: string, status: ReadingStatus): Promise<ReadingStatus | null>;
  /** The caller has validated and trimmed `patch`. False when the book does not exist. */
  update(id: string, patch: BookUpdate): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Null when the book does not exist. */
  notes(id: string): Promise<Note[] | null>;
  /** The caller has validated `change`. False when the book does not exist. */
  changeNotes(id: string, change: NoteChange): Promise<boolean>;
  /**
   * When each book was pinned, by id, as the reader's shelf names them. It may hold books that are no longer on the shelf,
   * which are not shown. Never rejects: pins that cannot be read leave the books unpinned, not the library unreadable.
   */
  pins(): Promise<ReadonlyMap<string, string>>;
  /**
   * Pins the book, or moves its pin to now, and says when. Null when the book does not exist.
   * `sharedIds` are the shelf's books that belong to other libraries (a shelf passes them, a plain library has none):
   * those are pinned here under their own ids, and the pins of books that are in neither place are cleared away.
   */
  pin(id: string, sharedIds?: ReadonlySet<string>): Promise<string | null>;
  /** False when the book does not exist; true also when it was not pinned. `sharedIds` as for `pin`. */
  unpin(id: string, sharedIds?: ReadonlySet<string>): Promise<boolean>;
  usage(): Promise<StorageUsage>;
  readCache(id: string, key: string): Promise<unknown>;
  writeCache(id: string, key: string, value: unknown): Promise<void>;
  /** What chapter-translation.ts kept of the chapter in `lang`. Null when nothing is kept, or it cannot be read. */
  readTranslation(id: string, lang: LangCode, chapterId: string): Promise<unknown>;
  /** Keeps it with the book, so it goes when the book goes. Never rejects: one not kept is made again next time. */
  writeTranslation(id: string, lang: LangCode, chapterId: string, value: unknown): Promise<void>;
  /**
   * Stops every change to the books, before a removed profile's files are cleared: resolves once the changes under way
   * (an upload being added, a place being saved) have finished, and every change after that throws LibraryClosedError
   * before it writes anything. Must not be called from inside one of those changes, which it would wait for forever.
   */
  close(): Promise<void>;
};

export function createLibrary(dataDir: string, options: LibraryOptions = {}): Library {
  const store = options.store ?? createLocalStore(dataDir);
  const limit = options.limit ?? null;
  const tempDir = options.tempDir ?? join(dataDir, "tmp");
  const shared = options.shared;

  const keyOf = (id: string, name: string): string => {
    if (!isBookId(id)) throw new Error(`invalid book id: ${JSON.stringify(id)}`);
    return `books/${id}/${name}`;
  };
  const folderOf = (id: string): string => keyOf(id, "");
  const translationOf = (id: string, lang: LangCode, chapterId: string): string =>
    keyOf(id, `translations/${lang}/${PLAIN_NAME.test(chapterId) ? chapterId : createHash("sha256").update(chapterId).digest("hex")}.json`);

  async function readJson(key: string): Promise<unknown> {
    const data = await store.read(key);
    return data && JSON.parse(data.toString("utf8"));
  }

  // What the store holds as far as this library knows: which books there are, and the meta.json of each once read.
  // Only one DeepRead may use a store (README) and every change to a book goes through changeMeta, so they stay true.
  let ids: Set<string> | null = null;
  const metas = new Map<string, BookMeta>();
  // Moves on with every change to a book: a read under way meanwhile may have seen it as it was, so it is not kept.
  let changes = 0;

  // Before the first call nothing is in flight, so anything left in tmp/ is debris from a crash, and so is a book
  // folder without its meta.json: a book that was being added or removed when DeepRead stopped.
  // Done on first use rather than at construction, so an unused library never touches the disk or the bucket.
  let initialized: Promise<void> | null = null;
  const ready = (): Promise<void> =>
    (initialized ??= (async () => {
      await rm(tempDir, { recursive: true, force: true });
      await mkdir(tempDir, { recursive: true });
      const objects = await store.list("books/");
      const complete = bookIdsIn(objects);
      // Only folders named like a book: anything else in there was not put there by DeepRead.
      const folders = objects.map((object) => /^books\/([^/]+)\//.exec(object.key)?.[1]).filter((id) => id !== undefined);
      for (const id of new Set(folders)) {
        if (isBookId(id) && !complete.has(id)) await store.removeAll(folderOf(id));
      }
      // Every change waits for this, so the listing still holds.
      ids = complete;
    })().catch((error: unknown) => {
      initialized = null;
      throw error;
    }));

  // Progress saves, deletes and adds on one book must not interleave their read-modify-write.
  // Every write to the store goes through here, so this is also where a closed library refuses them.
  let closed = false;
  const tails = new Map<string, Promise<unknown>>();
  function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    // Checked when the work's turn comes, not when it is queued: it may have been waiting while the library closed.
    const guarded = (): Promise<T> => {
      if (closed) throw new LibraryClosedError();
      return work();
    };
    const run = (tails.get(id) ?? Promise.resolve()).then(guarded, guarded);
    const tail = run.catch(() => {});
    tails.set(id, tail);
    void tail.then(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
    return run;
  }

  // A reader taps words constantly and each tap needs the whole book; parsing book.json every time adds up.
  const parsedBooks = new Map<string, ParsedBook>();
  function remember(id: string, book: ParsedBook): void {
    parsedBooks.delete(id);
    parsedBooks.set(id, book);
    if (parsedBooks.size > PARSED_BOOKS_KEPT) {
      const oldest = parsedBooks.keys().next();
      if (!oldest.done) parsedBooks.delete(oldest.value);
    }
  }

  async function readMeta(id: string): Promise<BookMeta | null> {
    await ready();
    const key = keyOf(id, "meta.json");
    const known = metas.get(id);
    if (known) return known;
    if (ids && !ids.has(id)) return null;
    const seen = changes;
    // A missing or damaged meta.json is not kept: the next read looks again.
    const meta = (await readJson(key)) as BookMeta | null;
    if (meta && changes === seen) metas.set(id, meta);
    return meta;
  }

  /**
   * Makes a change to a book's meta.json and remembers what it leaves: `after`, or no book when it is null. A change that
   * fails may still have reached the store, so then the book is forgotten and read again.
   */
  async function changeMeta(id: string, after: BookMeta | null, change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch (error) {
      metas.delete(id);
      ids = null;
      throw error;
    } finally {
      changes += 1;
    }
    if (after) {
      metas.set(id, after);
      ids?.add(id);
    } else {
      metas.delete(id);
      ids?.delete(id);
    }
  }

  const writeMeta = (meta: BookMeta): Promise<void> =>
    changeMeta(meta.id, meta, () => store.write(keyOf(meta.id, "meta.json"), JSON.stringify(meta)));

  async function exists(id: string): Promise<boolean> {
    await ready();
    const key = keyOf(id, "meta.json");
    return ids ? ids.has(id) : metas.has(id) || (await store.size(key)) !== null;
  }

  // When each book was pinned, as pins.json holds it once read. Replaced on every change, never changed in place, so a
  // listing under way keeps the pins it began with. Only one DeepRead may use a store, and every change goes through
  // changePin and forgetPin, so what is kept stays true.
  let pinned: ReadonlyMap<string, string> | null = null;
  // Moves on with every write, like `changes`: a read under way meanwhile may be older than the write, so it is not kept.
  let pinWrites = 0;

  async function readPins(): Promise<ReadonlyMap<string, string>> {
    if (pinned) return pinned;
    const seen = pinWrites;
    // Not kept when it fails: the next read looks again, and a write waits for one that works.
    const read = parsePins(await store.read(PINS_KEY));
    if (pinWrites === seen) pinned = read;
    return read;
  }

  /** Makes the pins what `edit` makes of them, unless that is what they are. Only called in the pinning queue. */
  async function writePins(edit: (current: ReadonlyMap<string, string>) => Map<string, string>): Promise<void> {
    const current = await readPins();
    const next = edit(current);
    if (next.size === current.size && [...next].every(([id, at]) => current.get(id) === at)) return;
    try {
      await store.write(PINS_KEY, JSON.stringify(Object.fromEntries(next)));
      pinned = next;
    } catch (error) {
      // It may have reached the store all the same.
      pinned = null;
      throw error;
    } finally {
      pinWrites += 1;
    }
  }

  /** Pins the book at `at`, or unpins it when `at` is null. False when the book does not exist. */
  const changePin = (id: string, at: string | null, sharedIds?: ReadonlySet<string>): Promise<boolean> =>
    serialized(PINNING, async () => {
      // Checked in the queue, so a book removed as it is pinned cannot keep its pin.
      if (!(isBookId(id) ? await exists(id) : sharedIds?.has(id) === true)) return false;
      const books = new Set(await bookIds());
      await writePins((current) => {
        // Also clears away the pins of books that are no longer on the shelf (a share that ended, a book that went).
        const next = new Map([...current].filter(([other]) => other !== id && (isBookId(other) ? books.has(other) : sharedIds?.has(other) === true)));
        if (at !== null) next.set(id, at);
        return next;
      });
      return true;
    });

  /** The book is gone: so is its pin. */
  const forgetPin = (id: string): Promise<void> =>
    serialized(PINNING, () => writePins((current) => new Map([...current].filter(([other]) => other !== id))));

  function toSummary(meta: BookMeta, pinnedAt?: string): BookSummary {
    return {
      id: meta.id,
      title: meta.title,
      author: meta.author,
      pageCount: meta.pageCount,
      chapterCount: meta.chapterCount,
      wordCount: meta.wordCount,
      addedAt: meta.addedAt,
      progress: meta.progress,
      readingStatus: meta.readingStatus ?? "reading",
      hasCover: meta.cover === true,
      ...(pinnedAt === undefined ? {} : { pinnedAt }),
    };
  }

  /** The pins to show: pins that cannot be read cost the pins on screen, not the library. */
  async function shownPins(): Promise<ReadonlyMap<string, string>> {
    try {
      return await readPins();
    } catch (error) {
      console.warn("could not read the pinned books, so none is shown as pinned:", error);
      return new Map();
    }
  }

  /** Fills in an old meta.json once, so listing never has to open the parsed book again. */
  async function completed(meta: BookMeta): Promise<BookMeta> {
    if (!lacksDetails(meta)) return meta;
    return serialized(meta.id, async () => {
      const fresh = await readMeta(meta.id);
      const book = fresh && (await loadBook(meta.id));
      if (!fresh || !book) return meta;
      const next = withDetails(fresh, book);
      if (next.progress) await writeMeta(next);
      return next;
    });
  }

  async function bookIds(): Promise<string[]> {
    await ready();
    if (ids) return [...ids];
    const seen = changes;
    const listed = bookIdsIn(await store.list("books/"));
    // A book added or removed while this was listed may be missing from it, or still in it.
    if (changes === seen) ids = listed;
    return [...listed];
  }

  async function loadBook(id: string): Promise<ParsedBook | null> {
    await ready();
    const cached = parsedBooks.get(id);
    if (cached) return cached;
    const book = (await readJson(keyOf(id, "book.json"))) as ParsedBook | null;
    if (book) remember(id, book);
    return book;
  }

  async function usage(): Promise<StorageUsage> {
    await ready();
    const objects = await store.list("books/");
    const used = objects.reduce((sum, object) => sum + object.size, 0);
    return { used, total: shared ? await shared.total() : used, limit, where: store.kind };
  }

  async function assertRoom(bytes: number): Promise<void> {
    if (limit === null) return;
    const now = await usage();
    if (now.total + bytes > limit) throw new StorageFullError(now, bytes);
  }

  /** The book's PDF as a file on this computer (tmp/<random>/<id>/source.pdf) while `work` runs. Null when it has none. */
  async function withLocalPdf<T>(id: string, work: (path: string) => Promise<T>): Promise<T | null> {
    await ready();
    const folder = join(tempDir, randomUUID());
    try {
      const path = join(folder, id, "source.pdf");
      await mkdir(dirname(path), { recursive: true });
      return (await store.download(keyOf(id, "source.pdf"), path)) ? await work(path) : null;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  return {
    async newUploadPath(title) {
      await ready();
      // A folder of its own, so two uploads with the same name never meet.
      const folder = join(tempDir, `upload-${randomUUID()}`);
      await mkdir(folder);
      return join(folder, `${title}.pdf`);
    },

    async discardUpload(uploadPath) {
      await rm(dirname(uploadPath), { recursive: true, force: true });
    },

    async list() {
      const pins = await shownPins();
      const metas = await Promise.all(
        (await bookIds()).map(async (id) => {
          try {
            const meta = await readMeta(id);
            return meta && (await completed(meta));
          } catch (error) {
            console.warn(`skipping unreadable book ${id}:`, error);
            return null;
          }
        }),
      );
      const found = metas.filter((meta) => meta !== null);
      found.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
      return found.map((meta) => toSummary(meta, pins.get(meta.id)));
    },

    async findBySha(sha256) {
      for (const id of await bookIds()) {
        // The id ends in a prefix of the file hash, which narrows the scan to a name check; meta settles it.
        const suffix = id.slice(id.lastIndexOf("-") + 1);
        if (suffix.length < HASH_CHARS || !sha256.startsWith(suffix)) continue;
        if ((await readMeta(id))?.sha256 === sha256) return id;
      }
      return null;
    },

    assertRoom,

    add({ uploadPath, sha256, parsed, cover }) {
      // One at a time, so two uploads cannot both fit in the room that is left for one.
      const oneAtATime = shared ? shared.adding : <T>(work: () => Promise<T>) => serialized(ADDING, work);
      return oneAtATime(async () => {
        await ready();
        const bookJson = JSON.stringify(parsed);
        const chapterWordCounts = Object.fromEntries(parsed.chapters.map((c) => [c.id, chapterWords(c)]));
        // Reading time is the book's own text: a title page, an index or a licence is not reading.
        const bodyWords = parsed.chapters
          .filter((c) => (c.kind ?? "body") === "body")
          .reduce((sum, c) => sum + (chapterWordCounts[c.id] ?? 0), 0);
        const slug = slugify(parsed.title);
        // 8 hash characters make a collision between two different files vanishingly rare, but never overwrite one.
        for (const chars of [HASH_CHARS, LONG_HASH_CHARS]) {
          const id = `${slug}-${sha256.slice(0, chars)}`;
          // In the book's own queue as well, so a removal of the same book still clearing its files cannot meet the new ones.
          const added = await serialized(id, async () => {
            const existing = await readMeta(id);
            if (existing?.sha256 === sha256) return { id, created: false };
            if (existing) return null;

            const meta: BookMeta = {
              id,
              title: parsed.title,
              author: parsed.author,
              pageCount: parsed.pageCount,
              chapterCount: parsed.chapters.length,
              wordCount: bodyWords,
              addedAt: new Date().toISOString(),
              progress: null,
              readingStatus: "reading",
              sha256,
              chapterWordCounts,
              cover: cover !== null,
            };
            const metaJson = JSON.stringify(meta);
            const pdfBytes = (await stat(uploadPath)).size;
            await assertRoom(pdfBytes + Buffer.byteLength(bookJson) + (cover?.data.byteLength ?? 0) + Buffer.byteLength(metaJson));

            try {
              // Whatever an earlier copy of this book left behind (old notes, old answers) must not become part of this one.
              await store.removeAll(folderOf(id));
              await store.putFile(keyOf(id, "source.pdf"), uploadPath);
              await store.write(keyOf(id, "book.json"), bookJson);
              if (cover) await store.write(keyOf(id, COVER_FILES[cover.type]), cover.data);
              // Last: the book is in the library from this moment, with everything it needs already stored.
              await writeMeta(meta);
            } catch (error) {
              // Whatever this leaves is cleared at the next start.
              await store.removeAll(folderOf(id)).catch(() => {});
              throw error;
            }
            return { id, created: true };
          });
          if (added) return added;
        }
        throw new Error("could not find a free book id");
      });
    },

    async detail(id) {
      const meta = await readMeta(id);
      const book = await loadBook(id);
      if (!meta || !book) return null;
      const chapters: ChapterSummary[] = book.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        kind: chapter.kind ?? "body",
        startPage: chapter.startPage,
        endPage: chapter.endPage,
        wordCount: meta.chapterWordCounts[chapter.id] ?? chapterWords(chapter),
      }));
      return { ...toSummary(withDetails(meta, book), (await shownPins()).get(id)), chapters, warnings: book.warnings };
    },

    async book(id) {
      const meta = await readMeta(id);
      const parsed = meta && (await loadBook(id));
      // meta.json owns the title and author, so an edit never has to rewrite the (large) parsed book.
      return meta && parsed ? { ...parsed, title: meta.title, author: meta.author } : null;
    },

    async pdf(id) {
      await ready();
      const key = keyOf(id, "source.pdf");
      const size = await store.size(key);
      return size === null ? null : { size, stream: (range) => store.stream(key, range) };
    },

    async cover(id) {
      await ready();
      for (const [type, name] of Object.entries(COVER_FILES) as Array<[CoverImage["type"], string]>) {
        const data = await store.read(keyOf(id, name));
        if (data) return { data: new Uint8Array(data), type };
      }
      return null;
    },

    async addMissingCovers(renderCover) {
      try {
        for (const id of await bookIds()) {
          // Its profile was removed meanwhile: every book left would only refuse.
          if (closed) return;
          try {
            if ((await readMeta(id))?.cover !== undefined) continue;
            // Drawn outside the queue: a reader saving their place in this book does not wait for the drawing.
            const cover = await withLocalPdf(id, renderCover);
            await serialized(id, async () => {
              const meta = await readMeta(id);
              // Removed while its cover was being drawn: writing now would bring part of it back.
              if (!meta) return;
              // The image first, so meta.json never promises a cover that is not there.
              if (cover) await store.write(keyOf(id, COVER_FILES[cover.type]), cover.data);
              await writeMeta({ ...meta, cover: cover !== null });
            });
          } catch (error) {
            console.warn(`could not look for the cover of ${id}:`, error);
          }
        }
      } catch (error) {
        console.warn("could not look for the covers of older books:", error);
      }
    },

    setProgress(id, chapterId, blockId, offset) {
      return serialized(id, async () => {
        const meta = await readMeta(id);
        const book = meta && (await loadBook(id));
        const where = meta && book && describePosition(book, meta.chapterWordCounts, chapterId, blockId, offset);
        if (!meta || !where) return null;
        const progress: ReadingProgress = { chapterId, blockId, offset, updatedAt: new Date().toISOString(), ...where };
        await writeMeta({ ...meta, progress });
        return progress;
      });
    },

    setReadingStatus(id, status) {
      return serialized(id, async () => {
        const meta = await readMeta(id);
        if (!meta) return null;
        await writeMeta({ ...meta, readingStatus: status });
        return status;
      });
    },

    update(id, patch) {
      return serialized(id, async () => {
        const meta = await readMeta(id);
        if (!meta) return false;
        await writeMeta({
          ...meta,
          title: patch.title ?? meta.title,
          author: patch.author === undefined ? meta.author : patch.author,
        });
        return true;
      });
    },

    remove(id) {
      return serialized(id, async () => {
        if (!(await exists(id))) return false;
        // meta.json first: the book leaves the library in one step, and the rest of its files go after it.
        await changeMeta(id, null, () => store.remove([keyOf(id, "meta.json")]));
        parsedBooks.delete(id);
        // After meta.json, so a pin made meanwhile either saw the book gone or is cleared here.
        await forgetPin(id).catch((error: unknown) => console.warn(`could not clear away the pin of removed book ${id}:`, error));
        try {
          await store.removeAll(folderOf(id));
        } catch (error) {
          // The book is gone already; what is left of its files is cleared at the next start.
          console.warn(`could not clear away all the files of removed book ${id}:`, error);
        }
        return true;
      });
    },

    async notes(id) {
      if (!(await exists(id))) return null;
      return ((await readJson(keyOf(id, "notes.json"))) as Note[] | null) ?? [];
    },

    changeNotes(id, change) {
      // In the book's queue: two devices changing notes at once each keep their change.
      return serialized(id, async () => {
        // Checked in the queue, so a note saved as the book is removed cannot outlive it.
        if (!(await exists(id))) return false;
        const key = keyOf(id, "notes.json");
        const notes = applyNoteChange(((await readJson(key)) as Note[] | null) ?? [], change);
        if (notes.length === 0) await store.remove([key]);
        else await store.write(key, JSON.stringify(notes));
        return true;
      });
    },

    pins: shownPins,

    async pin(id, sharedIds) {
      const at = new Date().toISOString();
      return (await changePin(id, at, sharedIds)) ? at : null;
    },

    unpin: (id, sharedIds) => changePin(id, null, sharedIds),

    usage,

    async readCache(id, key) {
      if (!CACHE_KEY.test(key)) return null;
      try {
        return await readJson(keyOf(id, `cache/${key}.json`));
      } catch (error) {
        // A damaged cache entry is just a miss; the next answer overwrites it.
        console.warn(`ignoring unreadable cache entry for ${id}:`, error);
        return null;
      }
    },

    async writeCache(id, key, value) {
      if (!CACHE_KEY.test(key)) return;
      try {
        await serialized(id, async () => {
          // If the book was removed while the answer was generating, its answer must not bring part of it back.
          if (await exists(id)) await store.write(keyOf(id, `cache/${key}.json`), JSON.stringify(value));
        });
      } catch (error) {
        // A cache that cannot be written only costs a regeneration next time.
        console.warn(`could not cache answer for ${id}:`, error);
      }
    },

    async readTranslation(id, lang, chapterId) {
      try {
        return await readJson(translationOf(id, lang, chapterId));
      } catch (error) {
        // A damaged translation is just a miss: the chapter is translated again, and written over it.
        console.warn(`ignoring unreadable translation of ${id}:`, error);
        return null;
      }
    },

    async writeTranslation(id, lang, chapterId, value) {
      try {
        await serialized(id, async () => {
          // If the book was removed while its chapter was translating, the translation must not bring part of it back.
          if (await exists(id)) await store.write(translationOf(id, lang, chapterId), JSON.stringify(value));
        });
      } catch (error) {
        console.warn(`could not keep the translation of ${id}:`, error);
      }
    },

    async close() {
      closed = true;
      // With a shared limit, adds wait in a queue of their own before they reach their book's: drained first, so an
      // add under way has finished (or refused) and whatever it queued on its book is among the tails awaited next.
      if (shared) await shared.adding(async () => {});
      await Promise.all(tails.values());
    },
  };
}
