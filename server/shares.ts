// Books one profile shares with another. shares.json, at the root of the store, says who may read which book of
// whose. The book itself stays in its owner's library and is never written to by the reader: their place, notes and
// cached answers for it are their own, in profiles/<reader>/shared/<owner>--<book>/. Stopping a share leaves those where
// they are, so sharing the book again gives the reader back where they were; removing the book clears them away.
import type { NoteChange } from "../shared/notes.ts";
import { applyNoteChange } from "../shared/notes.ts";
import type { BookSummary, Note, PublicProfile, ReadingProgress } from "../shared/types.ts";
import { isRecord } from "./http.ts";
import { isBookId, isCacheKey } from "./library.ts";
import type { Library } from "./library.ts";
import { describePosition } from "./progress.ts";
import { scopedStore } from "./storage.ts";
import type { ObjectStore } from "./storage.ts";

export type Share = { ownerId: string; bookId: string; recipientId: string; sharedAt: string };

const SHARES_KEY = "shares.json";
// Neither a profile id nor a book id ever holds two hyphens in a row, so this splits a shared id one way only, and
// no id of the reader's own books can look like one.
const SEPARATOR = "--";
const STATE_FOLDER = /^profiles\/[^/]+\/shared\/([^/]+)\//;

/** The id a book shared with the reader goes by on their shelf, in every address of it. */
export const sharedBookId = (ownerId: string, bookId: string): string => `${ownerId}${SEPARATOR}${bookId}`;

export function parseSharedBookId(id: string): { ownerId: string; bookId: string } | null {
  const at = id.indexOf(SEPARATOR);
  if (at === -1) return null;
  const ownerId = id.slice(0, at);
  const bookId = id.slice(at + SEPARATOR.length);
  return isBookId(ownerId) && isBookId(bookId) ? { ownerId, bookId } : null;
}

/** One of the reader's own books, or one shared with them: only the library can say whether it is there. */
export const isReadableBookId = (id: string): boolean => isBookId(id) || parseSharedBookId(id) !== null;

function isShare(value: unknown): value is Share {
  return (
    isRecord(value) &&
    typeof value.ownerId === "string" &&
    typeof value.bookId === "string" &&
    typeof value.recipientId === "string" &&
    typeof value.sharedAt === "string" &&
    isBookId(value.ownerId) &&
    isBookId(value.bookId) &&
    isBookId(value.recipientId)
  );
}

const sameShare = (share: Share, ownerId: string, bookId: string, recipientId: string): boolean =>
  share.ownerId === ownerId && share.bookId === bookId && share.recipientId === recipientId;

/** Runs the works given to it one after another, each starting once the one before has settled. */
function createQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}

export type Shares = {
  list(): Promise<Share[]>;
  find(ownerId: string, bookId: string, recipientId: string): Promise<Share | null>;
  /** Shares the book; sharing it again with the same reader keeps the first date. */
  add(ownerId: string, bookId: string, recipientId: string): Promise<void>;
  /** False when it was not shared. The reader's place and notes stay, hidden, for a later share. */
  remove(ownerId: string, bookId: string, recipientId: string): Promise<boolean>;
  /** The book was removed: its shares end and what its readers kept of it goes too. */
  forgetBook(ownerId: string, bookId: string): Promise<void>;
  /** The profile was removed: every share from it or to it ends, and what others kept of its books goes too. */
  forgetProfile(profileId: string): Promise<void>;
};

/** `store` is the whole store: shares.json sits at its root, and each reader's own copy of what they keep under profiles/. */
export function createShares(store: ObjectStore): Shares {
  let cached: Share[] | null = null;
  const changes = createQueue();

  async function read(): Promise<Share[]> {
    if (cached) return cached;
    const data = await store.read(SHARES_KEY);
    let parsed: unknown = null;
    try {
      parsed = data && JSON.parse(data.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    const list = data ? (isRecord(parsed) ? parsed.shares : null) : [];
    // Never treated as empty: writing over it would end every share without anyone asking for it.
    if (!Array.isArray(list) || !list.every(isShare)) {
      throw new Error(`${SHARES_KEY} is damaged, so the shared books cannot be read. Restore it from a copy, or mend it by hand.`);
    }
    cached = list;
    return list;
  }

  /** Lets `edit` change the list, and writes it back when it did. */
  const change = (edit: (current: Share[]) => Share[]): Promise<void> =>
    changes(async () => {
      const current = await read();
      const next = edit(current);
      if (next === current) return;
      await store.write(SHARES_KEY, JSON.stringify({ shares: next }, null, 2));
      cached = next;
    });

  /** Removes the reader copies whose shared id `matches`, wherever they are. */
  async function clearReaderCopies(matches: (id: string) => boolean): Promise<void> {
    const folders = new Set<string>();
    for (const { key } of await store.list("profiles/")) {
      const found = STATE_FOLDER.exec(key);
      if (found?.[1] && matches(found[1])) folders.add(found[0]);
    }
    for (const folder of folders) await store.removeAll(folder);
  }

  return {
    list: read,

    async find(ownerId, bookId, recipientId) {
      return (await read()).find((share) => sameShare(share, ownerId, bookId, recipientId)) ?? null;
    },

    add(ownerId, bookId, recipientId) {
      return change((current) =>
        current.some((share) => sameShare(share, ownerId, bookId, recipientId))
          ? current
          : [...current, { ownerId, bookId, recipientId, sharedAt: new Date().toISOString() }],
      );
    },

    async remove(ownerId, bookId, recipientId) {
      let removed = false;
      await change((current) => {
        const next = current.filter((share) => !sameShare(share, ownerId, bookId, recipientId));
        removed = next.length !== current.length;
        return removed ? next : current;
      });
      return removed;
    },

    async forgetBook(ownerId, bookId) {
      await change((current) => {
        const next = current.filter((share) => share.ownerId !== ownerId || share.bookId !== bookId);
        return next.length === current.length ? current : next;
      });
      const id = sharedBookId(ownerId, bookId);
      await clearReaderCopies((found) => found === id);
    },

    async forgetProfile(profileId) {
      await change((current) => {
        const next = current.filter((share) => share.ownerId !== profileId && share.recipientId !== profileId);
        return next.length === current.length ? current : next;
      });
      await clearReaderCopies((found) => parseSharedBookId(found)?.ownerId === profileId);
    },
  };
}

/** What a reader keeps of the books shared with them: their place, their notes and their cached answers, by shared id. */
function readerCopies(store: ObjectStore) {
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
  async function readJson(key: string): Promise<unknown> {
    const data = await store.read(key);
    return data && JSON.parse(data.toString("utf8"));
  }
  // The reader's place in each shared book, by share: while a share lasts only this shelf writes it, and Shares keeps one
  // object per share, so a share that ends and starts again is a new one whose place is read afresh.
  const places = new WeakMap<Share, ReadingProgress | null>();
  // Moves on with every save: a read under way meanwhile may be older than the save, so it is not kept.
  let saves = 0;
  const placeOf = (share: Share): string => `${sharedBookId(share.ownerId, share.bookId)}/progress.json`;

  return {
    async progress(share: Share): Promise<ReadingProgress | null> {
      if (places.has(share)) return places.get(share) ?? null;
      const seen = saves;
      const progress = ((await readJson(placeOf(share))) as ReadingProgress | null) ?? null;
      if (saves === seen) places.set(share, progress);
      return progress;
    },
    saveProgress: (share: Share, progress: ReadingProgress) =>
      // In the book's queue, so the place kept here is the one the store got last.
      serialized(sharedBookId(share.ownerId, share.bookId), async () => {
        try {
          await store.write(placeOf(share), JSON.stringify(progress));
          places.set(share, progress);
        } catch (error) {
          // It may have reached the store all the same.
          places.delete(share);
          throw error;
        } finally {
          saves += 1;
        }
      }),
    notes: async (id: string) => ((await readJson(`${id}/notes.json`)) as Note[] | null) ?? [],
    changeNotes: (id: string, change: NoteChange) =>
      // Two devices changing notes at once each keep their change.
      serialized(id, async () => {
        const key = `${id}/notes.json`;
        const notes = applyNoteChange(((await readJson(key)) as Note[] | null) ?? [], change);
        if (notes.length === 0) await store.remove([key]);
        else await store.write(key, JSON.stringify(notes));
      }),
    async readCache(id: string, key: string): Promise<unknown> {
      try {
        return await readJson(`${id}/cache/${key}.json`);
      } catch {
        // A damaged entry is just a miss.
        return null;
      }
    },
    writeCache: (id: string, key: string, value: unknown) => store.write(`${id}/cache/${key}.json`, JSON.stringify(value)),
  };
}

export type ShelfDeps = {
  /** The whole store: the reader's own copies of what they keep are written under profiles/<reader>/shared/. */
  store: ObjectStore;
  shares: Shares;
  /** The library of a profile, or null when there is no such profile. */
  libraryOf(id: string): Library | null;
  /** What anyone may see of a profile, or null when there is no such profile. */
  profileOf(id: string): PublicProfile | null;
};

const newestFirst = (a: BookSummary, b: BookSummary): number => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id);

/**
 * The reader's shelf: their own library, with the books shared with them alongside, read through their owners'
 * libraries. Anything that would change a shared book itself is refused, and so is its PDF, which stays its owner's;
 * taking it off the shelf ends the share.
 */
export function readerShelf(own: Library, readerId: string, deps: ShelfDeps): Library {
  const { shares } = deps;
  const copies = readerCopies(scopedStore(deps.store, `profiles/${readerId}/shared/`));

  /** Where a book shared with this reader comes from; null for an id that is not one, or a share that has ended. */
  async function source(id: string) {
    const parts = parseSharedBookId(id);
    if (!parts || parts.ownerId === readerId) return null;
    const share = await shares.find(parts.ownerId, parts.bookId, readerId);
    const library = share && deps.libraryOf(parts.ownerId);
    const owner = share && deps.profileOf(parts.ownerId);
    return share && library && owner ? { library, bookId: parts.bookId, owner, share } : null;
  }

  async function shelved(id: string, summary: BookSummary, owner: PublicProfile, share: Share): Promise<BookSummary> {
    return { ...summary, id, addedAt: share.sharedAt, progress: await copies.progress(share), sharedBy: owner };
  }

  return {
    ...own,

    async list() {
      const mine = await own.list();
      const received = (await shares.list()).filter((share) => share.recipientId === readerId);
      // One listing for each owner, however many of their books are shared with this reader.
      const owners = new Map<string, Promise<BookSummary[]>>();
      const shared = await Promise.all(
        received.map(async (share) => {
          const library = deps.libraryOf(share.ownerId);
          const owner = deps.profileOf(share.ownerId);
          if (!library || !owner) return null;
          if (!owners.has(share.ownerId)) owners.set(share.ownerId, library.list());
          const summary = (await owners.get(share.ownerId))?.find((book) => book.id === share.bookId);
          return summary ? shelved(sharedBookId(share.ownerId, share.bookId), summary, owner, share) : null;
        }),
      );
      return [...mine, ...shared.filter((book) => book !== null)].sort(newestFirst);
    },

    async detail(id) {
      if (isBookId(id)) return own.detail(id);
      const from = await source(id);
      const detail = from && (await from.library.detail(from.bookId));
      return from && detail ? { ...detail, ...(await shelved(id, detail, from.owner, from.share)) } : null;
    },

    async book(id) {
      if (isBookId(id)) return own.book(id);
      const from = await source(id);
      return from ? from.library.book(from.bookId) : null;
    },

    async pdf(id) {
      // A shared book is read here, in its chapters; the owner's own file never leaves their library.
      return isBookId(id) ? own.pdf(id) : null;
    },

    async cover(id) {
      if (isBookId(id)) return own.cover(id);
      const from = await source(id);
      return from ? from.library.cover(from.bookId) : null;
    },

    async setProgress(id, chapterId, blockId, offset) {
      if (isBookId(id)) return own.setProgress(id, chapterId, blockId, offset);
      const from = await source(id);
      const book = from && (await from.library.book(from.bookId));
      const detail = from && (await from.library.detail(from.bookId));
      if (!from || !book || !detail) return null;
      const wordCounts = Object.fromEntries(detail.chapters.map((chapter) => [chapter.id, chapter.wordCount]));
      const where = describePosition(book, wordCounts, chapterId, blockId, offset);
      if (!where) return null;
      const progress: ReadingProgress = { chapterId, blockId, offset, updatedAt: new Date().toISOString(), ...where };
      await copies.saveProgress(from.share, progress);
      return progress;
    },

    async update(id, patch) {
      // Only its owner changes a shared book.
      return isBookId(id) ? own.update(id, patch) : false;
    },

    async remove(id) {
      if (isBookId(id)) {
        const removed = await own.remove(id);
        if (removed) await shares.forgetBook(readerId, id);
        return removed;
      }
      // Off this reader's shelf only: the owner keeps the book.
      const parts = parseSharedBookId(id);
      return parts !== null && (await shares.remove(parts.ownerId, parts.bookId, readerId));
    },

    async notes(id) {
      if (isBookId(id)) return own.notes(id);
      return (await source(id)) ? copies.notes(id) : null;
    },

    async changeNotes(id, change) {
      if (isBookId(id)) return own.changeNotes(id, change);
      if (!(await source(id))) return false;
      await copies.changeNotes(id, change);
      return true;
    },

    async readCache(id, key) {
      if (isBookId(id)) return own.readCache(id, key);
      return isCacheKey(key) && (await source(id)) ? copies.readCache(id, key) : null;
    },

    async writeCache(id, key, value) {
      if (isBookId(id)) return own.writeCache(id, key, value);
      if (!isCacheKey(key) || !(await source(id))) return;
      // A cache that cannot be written only costs a regeneration next time.
      await copies.writeCache(id, key, value).catch((error: unknown) => console.warn(`could not cache answer for ${id}:`, error));
    },
  };
}
