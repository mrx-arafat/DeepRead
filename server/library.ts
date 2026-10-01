// Disk storage: <dataDir>/books/<id>/{source.pdf, book.json, meta.json, cache/}.
// A book becomes visible only when its whole directory is renamed into place, so a crash can never
// leave a half-written book; meta.json carries everything the list view needs so listing never opens book.json.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  BookDetail,
  BookSummary,
  BookUpdate,
  Chapter,
  ChapterSummary,
  ParsedBook,
  ReadingProgress,
} from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { describePosition } from "./progress.ts";

// Ids are a lowercase slug plus a hash. Anything else cannot be a book, so it never reaches the filesystem.
const BOOK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CACHE_KEY = /^[0-9a-f]{64}$/;
const MAX_SLUG = 48;
const HASH_CHARS = 8;
const LONG_HASH_CHARS = 16;
const PARSED_BOOKS_KEPT = 4;

export function isBookId(id: string): boolean {
  return id.length <= 96 && BOOK_ID.test(id);
}

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  // Titles with no Latin letters (Bangla, Arabic...) still get a usable id.
  return slug === "" ? "book" : slug;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function chapterWords(chapter: Chapter): number {
  return chapter.blocks.reduce((sum, block) => sum + countWords(block.text), 0);
}

/** What meta.json holds: the list-view summary plus what dedupe and the detail view need. */
type BookMeta = BookSummary & {
  sha256: string;
  chapterWordCounts: Record<string, number>;
};

/** Progress saved before it carried a chapter title and a percentage: those are filled in from the book. */
function lacksDetails(meta: BookMeta): boolean {
  return meta.progress !== null && typeof meta.progress.percent !== "number";
}

function withDetails(meta: BookMeta, book: ParsedBook): BookMeta {
  const { progress } = meta;
  if (!progress || !lacksDetails(meta)) return meta;
  const where = describePosition(book, meta.chapterWordCounts, progress.chapterId, progress.blockId);
  // A spot that is no longer in the book cannot be named, so the library shows the book as unstarted.
  return { ...meta, progress: where && { ...progress, ...where } };
}

export type NewBook = {
  /** A finished upload on disk; it is moved into the library. */
  uploadPath: string;
  sha256: string;
  parsed: ParsedBook;
};

export type Library = {
  /**
   * Where the next upload should be written; same filesystem as the library so moving it is atomic.
   * The file is named `title`, which is what the parser calls a book whose PDF has no title of its own.
   */
  newUploadPath(title: string): Promise<string>;
  /** Removes an upload that was not added to the library. */
  discardUpload(uploadPath: string): Promise<void>;
  list(): Promise<BookSummary[]>;
  findBySha(sha256: string): Promise<string | null>;
  add(book: NewBook): Promise<{ id: string; created: boolean }>;
  detail(id: string): Promise<BookDetail | null>;
  /** The parsed book as the reader sees it: with the title and author the reader last set. */
  book(id: string): Promise<ParsedBook | null>;
  pdf(id: string): Promise<{ path: string; size: number } | null>;
  setProgress(id: string, chapterId: string, blockId: string): Promise<ReadingProgress | null>;
  /** The caller has validated and trimmed `patch`. False when the book does not exist. */
  update(id: string, patch: BookUpdate): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  readCache(id: string, key: string): Promise<unknown>;
  writeCache(id: string, key: string, value: unknown): Promise<void>;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function createLibrary(dataDir: string): Library {
  const booksDir = join(dataDir, "books");
  const tempDir = join(dataDir, "tmp");

  // Anything left in tmp/ is debris from a crash, and nothing is in flight before the first call.
  // Done on first use rather than at construction, so an unused library never touches the disk.
  let initialized: Promise<void> | null = null;
  const ready = (): Promise<void> =>
    (initialized ??= (async () => {
      await rm(tempDir, { recursive: true, force: true });
      await mkdir(tempDir, { recursive: true });
      await mkdir(booksDir, { recursive: true });
    })().catch((error: unknown) => {
      initialized = null;
      throw error;
    }));

  const dirOf = (id: string): string => {
    if (!isBookId(id)) throw new Error(`invalid book id: ${JSON.stringify(id)}`);
    return join(booksDir, id);
  };

  // Progress saves, deletes and adds on one book must not interleave their read-modify-write.
  const tails = new Map<string, Promise<unknown>>();
  function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (tails.get(id) ?? Promise.resolve()).then(work, work);
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
    return (await readJson(join(dirOf(id), "meta.json"))) as BookMeta | null;
  }

  function toSummary(meta: BookMeta): BookSummary {
    return {
      id: meta.id,
      title: meta.title,
      author: meta.author,
      pageCount: meta.pageCount,
      chapterCount: meta.chapterCount,
      wordCount: meta.wordCount,
      addedAt: meta.addedAt,
      progress: meta.progress,
    };
  }

  /** Fills in an old meta.json once, so listing never has to open the parsed book again. */
  async function completed(meta: BookMeta): Promise<BookMeta> {
    if (!lacksDetails(meta)) return meta;
    return serialized(meta.id, async () => {
      const fresh = await readMeta(meta.id);
      const book = fresh && (await loadBook(meta.id));
      if (!fresh || !book) return meta;
      const next = withDetails(fresh, book);
      if (next.progress) await writeFileAtomic(join(dirOf(meta.id), "meta.json"), JSON.stringify(next));
      return next;
    });
  }

  async function bookIds(): Promise<string[]> {
    await ready();
    const entries = await readdir(booksDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isBookId(entry.name)).map((entry) => entry.name);
  }

  async function loadBook(id: string): Promise<ParsedBook | null> {
    await ready();
    const cached = parsedBooks.get(id);
    if (cached) return cached;
    const book = (await readJson(join(dirOf(id), "book.json"))) as ParsedBook | null;
    if (book) remember(id, book);
    return book;
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
      const metas: BookMeta[] = [];
      for (const id of await bookIds()) {
        try {
          const meta = await readMeta(id);
          if (meta) metas.push(await completed(meta));
        } catch (error) {
          console.warn(`skipping unreadable book ${id}:`, error);
        }
      }
      metas.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
      return metas.map(toSummary);
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

    async add({ uploadPath, sha256, parsed }) {
      await ready();
      const staging = join(tempDir, `book-${randomUUID()}`);
      try {
        await mkdir(join(staging, "cache"), { recursive: true });
        await rename(uploadPath, join(staging, "source.pdf"));
        await writeFileAtomic(join(staging, "book.json"), JSON.stringify(parsed));

        const chapterWordCounts = Object.fromEntries(parsed.chapters.map((c) => [c.id, chapterWords(c)]));
        // Reading time is the book's own text: a title page, an index or a licence is not reading.
        const bodyWords = parsed.chapters
          .filter((c) => (c.kind ?? "body") === "body")
          .reduce((sum, c) => sum + (chapterWordCounts[c.id] ?? 0), 0);
        const slug = slugify(parsed.title);
        // 8 hash characters make a collision between two different files vanishingly rare, but never overwrite one.
        for (const chars of [HASH_CHARS, LONG_HASH_CHARS]) {
          const id = `${slug}-${sha256.slice(0, chars)}`;
          const meta: BookMeta = {
            id,
            title: parsed.title,
            author: parsed.author,
            pageCount: parsed.pageCount,
            chapterCount: parsed.chapters.length,
            wordCount: bodyWords,
            addedAt: new Date().toISOString(),
            progress: null,
            sha256,
            chapterWordCounts,
          };
          await writeFileAtomic(join(staging, "meta.json"), JSON.stringify(meta));
          try {
            await rename(staging, dirOf(id));
            return { id, created: true };
          } catch (error) {
            const taken = error instanceof Error && "code" in error && (error.code === "ENOTEMPTY" || error.code === "EEXIST");
            if (!taken) throw error;
            if ((await readMeta(id))?.sha256 === sha256) return { id, created: false };
          }
        }
        throw new Error("could not find a free book id");
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
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
      return { ...toSummary(withDetails(meta, book)), chapters, warnings: book.warnings };
    },

    async book(id) {
      const meta = await readMeta(id);
      const parsed = meta && (await loadBook(id));
      // meta.json owns the title and author, so an edit never has to rewrite the (large) parsed book.
      return meta && parsed ? { ...parsed, title: meta.title, author: meta.author } : null;
    },

    async pdf(id) {
      await ready();
      const path = join(dirOf(id), "source.pdf");
      try {
        return { path, size: (await stat(path)).size };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    setProgress(id, chapterId, blockId) {
      return serialized(id, async () => {
        await ready();
        const meta = await readMeta(id);
        const book = meta && (await loadBook(id));
        const where = meta && book && describePosition(book, meta.chapterWordCounts, chapterId, blockId);
        if (!meta || !where) return null;
        const progress: ReadingProgress = { chapterId, blockId, updatedAt: new Date().toISOString(), ...where };
        await writeFileAtomic(join(dirOf(id), "meta.json"), JSON.stringify({ ...meta, progress }));
        return progress;
      });
    },

    update(id, patch) {
      return serialized(id, async () => {
        const meta = await readMeta(id);
        if (!meta) return false;
        const next: BookMeta = {
          ...meta,
          title: patch.title ?? meta.title,
          author: patch.author === undefined ? meta.author : patch.author,
        };
        await writeFileAtomic(join(dirOf(id), "meta.json"), JSON.stringify(next));
        return true;
      });
    },

    remove(id) {
      return serialized(id, async () => {
        await ready();
        const doomed = join(tempDir, `deleted-${randomUUID()}`);
        try {
          // Rename first: the book disappears in one atomic step, and the slow recursive delete happens after.
          await rename(dirOf(id), doomed);
        } catch (error) {
          if (isMissing(error)) return false;
          throw error;
        }
        parsedBooks.delete(id);
        await rm(doomed, { recursive: true, force: true });
        return true;
      });
    },

    async readCache(id, key) {
      if (!CACHE_KEY.test(key)) return null;
      try {
        return await readJson(join(dirOf(id), "cache", `${key}.json`));
      } catch (error) {
        // A damaged cache file is just a miss; the next answer overwrites it.
        console.warn(`ignoring unreadable cache entry for ${id}:`, error);
        return null;
      }
    },

    async writeCache(id, key, value) {
      if (!CACHE_KEY.test(key)) return;
      try {
        // No mkdir: if the book was deleted while the answer was generating, this must fail, not resurrect it.
        await writeFileAtomic(join(dirOf(id), "cache", `${key}.json`), JSON.stringify(value));
      } catch (error) {
        // A cache that cannot be written only costs a regeneration next time.
        if (!isMissing(error)) console.warn(`could not cache answer for ${id}:`, error);
      }
    },
  };
}
