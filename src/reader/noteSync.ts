// Keeps a book's notes in step with DeepRead, which keeps them with the book so they outlive this browser and follow
// the reader to another device. Only the request is kept: the server caches the answers.
// Each change is sent on its own (shared/notes.ts), so notes added on another device in the meantime stay. A change
// DeepRead has not taken yet waits in this browser's outbox, and goes with the next change or the next load.
// One browser can hold several profiles, and the same PDF has the same book id in each, so everything this browser
// keeps is filed under the profile it belongs to: one profile's unsent notes are never sent into another's library.
import { applyNoteChange } from "../../shared/notes.ts";
import type { NoteChange } from "../../shared/notes.ts";
import type { LangCode, Note, SessionInfo } from "../../shared/types.ts";
import { ApiFailure, api } from "../api.ts";

/** Whose notes these are: a profile's, or the one library's when there are no profiles. */
export type NoteOwner = {
  /** The signed-in profile (the one being read as, when the admin views another); null when there are no profiles. */
  profileId: string | null;
  /**
   * Whether the library is the one that existed before profiles: with no profiles, or for the admin's profile, which
   * inherited it. Only then are the notes older versions kept here, with no profile on them, this reader's to adopt.
   */
  inheritsOldNotes: boolean;
};

export type NoteSyncOptions = NoteOwner & {
  bookId: string;
  /** The language for notes saved before each one kept its own: they were shown in the current one. */
  lang: LangCode;
  /** Called with the notes as the reader should see them, whenever that changes. */
  onChange: (notes: Note[]) => void;
  onStatus?: (state: NoteSyncState) => void;
  api?: Pick<typeof api, "changeNote" | "getNotes">;
  /** This browser's localStorage when not given. */
  storage?: Storage | null;
};

export interface NoteSyncState {
  phase: "saving" | "saved" | "offline" | "rejected" | "storage-unavailable";
  pending: number;
  /** Pending changes survive reopening this browser; only `saved` means DeepRead acknowledged them. */
  durable: boolean;
  reason?: "sign-in" | "connection" | "refused";
}

export type NoteSync = {
  /** The notes as the reader sees them: those DeepRead has, with the changes still on their way. */
  current(): Note[];
  state(): NoteSyncState;
  /** Shows the change at once and sends it. Resolves once DeepRead took it, refused it, or could not be reached. */
  change(change: NoteChange): Promise<void>;
  /** Sends what waits from before, then loads the book's notes. */
  load(): Promise<void>;
  /** Sends what waits, then looks again for notes added on another device. Asks that come while one is on its way share it. */
  refresh(): Promise<void>;
  /** Explicitly retries refused changes as well as changes waiting for a connection. */
  retry(): Promise<void>;
  /** Discards only refused changes; other pending changes are still sent. */
  discardRejected(): Promise<void>;
  /** The page has moved on: nothing more is reported or sent. */
  close(): void;
};

const outboxKey = (owner: NoteOwner, bookId: string) => `deepread.pendingNotes.${owner.profileId ?? "single"}.${bookId}`;
const operationPrefix = (owner: NoteOwner, bookId: string) => `${outboxKey(owner, bookId)}.operations.`;
// Where the previous version kept the outbox, before it was filed under a profile.
const unfiledOutboxKey = (bookId: string) => `deepread.pendingNotes.${bookId}`;
// Where this browser kept the notes before they were kept with the book: per book, and before that per chapter.
const oldKey = (bookId: string) => `deepread.notes.${bookId}`;

/** Who is reading, from what DeepRead says about the session. */
export function noteOwner(info: SessionInfo | null): NoteOwner {
  const profile = info?.mode === "profiles" ? info.session?.profile : null;
  return profile ? { profileId: profile.id, inheritsOldNotes: profile.admin } : { profileId: null, inheritsOldNotes: true };
}

/** Answers that mean "try again later", not "never": the session ended, the request timed out, too many requests. */
const NOT_NOW: readonly number[] = [401, 408, 429];

/** localStorage, or null where the browser refuses it (blocked site data, some private windows). */
function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function oldKeys(storage: Storage, bookId: string): string[] {
  const key = oldKey(bookId);
  const keys: string[] = [];
  for (let at = 0; at < storage.length; at += 1) {
    const name = storage.key(at);
    if (name === key || name?.startsWith(`${key}.`)) keys.push(name);
  }
  return keys;
}

function matchingKeys(storage: Storage, prefix: string): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(prefix));
}

interface PendingNote {
  id: string;
  order: number;
  change: NoteChange;
  persisted: boolean;
  rejected: boolean;
  legacySource?: string;
}

function isChange(value: unknown): value is NoteChange {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === "remove") return "id" in value && typeof value.id === "string";
  if (value.kind !== "put" || !("note" in value) || !value.note || typeof value.note !== "object" || !("before" in value)) return false;
  const note = value.note;
  return ["id", "chapterId", "blockId", "quote", "mode"].every((field) => field in note && typeof Reflect.get(note, field) === "string") &&
    (value.before === null || typeof value.before === "string");
}

/** Clears what this browser holds of a removed book's notes for this reader: other profiles' copies are theirs. */
export function forgetHeldNotes(bookId: string, owner: NoteOwner, storage = browserStorage()): void {
  try {
    if (!storage) return;
    const keys = owner.inheritsOldNotes ? [unfiledOutboxKey(bookId), ...oldKeys(storage, bookId)] : [];
    for (const key of [outboxKey(owner, bookId), ...matchingKeys(storage, operationPrefix(owner, bookId)), ...keys]) storage.removeItem(key);
  } catch (error) {
    // The book is already gone; notes that could not be cleared are only wasted space.
    console.warn("could not remove the notes of a deleted book:", error);
  }
}

export function createNoteSync(options: NoteSyncOptions): NoteSync {
  const { bookId, lang, onChange } = options;
  const owner: NoteOwner = { profileId: options.profileId, inheritsOldNotes: options.inheritsOldNotes };
  const server = options.api ?? api;
  const storage = options.storage === undefined ? browserStorage() : options.storage;

  // The notes DeepRead has (none until they load), and the changes it has not taken yet.
  let kept: Note[] = [];
  let outbox: PendingNote[] = [];
  let storageHealthy = storage !== null;
  let legacyProblem = false;
  let phase: NoteSyncState["phase"] = "saving";
  let reason: NoteSyncState["reason"];
  // Sends and the load run one after another, so changes reach DeepRead in the order they were made.
  let queue: Promise<void> = Promise.resolve();
  let appending: Promise<void> = Promise.resolve();
  let closed = false;
  // The refresh that is waiting its turn or running, so asking again meanwhile does not fetch twice.
  let refreshing: Promise<void> | null = null;
  // The notes last reported, so a refresh that finds nothing new does not make the page draw them again.
  let shown: string | null = null;
  let shownStatus: string | null = null;
  const completed = new Set<string>();
  const prefix = operationPrefix(owner, bookId);
  const operationKey = (entry: PendingNote) => `${prefix}${entry.id}`;
  const rejectionKey = (entry: PendingNote) => `${operationKey(entry)}.rejected`;
  const legacySourceKey = (id: string): string | null => {
    const match = /^legacy-(.+)-\d+$/.exec(id);
    try { return match ? decodeURIComponent(match[1]!) : null; } catch { return null; }
  };

  /** The changes waiting from before, notes this browser kept before they were kept with the book among them. */
  function reconcile(): void {
    if (!storage) return;
    try {
      let healthy = true;
      const entries: PendingNote[] = [];
      const local = new Map(outbox.map((entry) => [entry.id, entry]));
      for (const key of matchingKeys(storage, prefix).filter((key) => !key.endsWith(".rejected") && !key.endsWith(".done"))) {
        const id = key.slice(prefix.length);
        if (completed.has(id) || storage.getItem(`${key}.done`) !== null) {
          try {
            storage.removeItem(key);
            storage.removeItem(`${key}.rejected`);
            const source = legacySourceKey(id);
            if (!source || storage.getItem(source) === null) storage.removeItem(`${key}.done`);
          } catch { healthy = false; }
          continue;
        }
        try {
          const saved: unknown = JSON.parse(storage.getItem(key) ?? "null");
          if (!saved || typeof saved !== "object" || !("order" in saved) || !Number.isSafeInteger(saved.order) || !("change" in saved) || !isChange(saved.change)) {
            throw new Error("Unreadable pending note");
          }
          entries.push({ id, order: saved.order as number, change: saved.change, persisted: true, rejected: local.get(id)?.rejected === true || storage.getItem(`${key}.rejected`) !== null });
        } catch {
          healthy = false;
        }
      }
      // A missing durable operation was acknowledged or discarded in another tab. Never write it back.
      outbox = [...entries, ...outbox.filter((entry) => !entry.persisted && !entries.some((saved) => saved.id === entry.id) && (!entry.legacySource || storage.getItem(entry.legacySource) !== null))];
      outbox.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      storageHealthy = healthy;
    } catch {
      storageHealthy = false;
    }
  }

  function persist(entry: PendingNote): void {
    if (!storage) { storageHealthy = false; return; }
    try {
      storage.setItem(operationKey(entry), JSON.stringify({ order: entry.order, change: entry.change }));
      entry.persisted = true;
      if (entry.rejected) storage.setItem(rejectionKey(entry), "true");
    } catch {
      storageHealthy = false;
    }
  }

  function migrate(): void {
    if (!storage) return;
    legacyProblem = false;
    let keys: string[];
    try { keys = [...(owner.inheritsOldNotes ? oldKeys(storage, bookId) : []), ...(owner.inheritsOldNotes ? [unfiledOutboxKey(bookId)] : []), outboxKey(owner, bookId)]; }
    catch { storageHealthy = false; legacyProblem = true; return; }
    for (const key of keys) {
      try {
        const source = storage.getItem(key);
        if (source === null) continue;
        const saved: unknown = JSON.parse(source);
        if (!Array.isArray(saved)) throw new Error("Unreadable pending notes");
        const old = key === oldKey(bookId) || key.startsWith(`${oldKey(bookId)}.`);
        const changes: unknown[] = old ? saved.map((value: Note) => ({ kind: "put", note: { ...value, lang: value.lang ?? lang, ...(key !== oldKey(bookId) ? { chapterId: key.slice(oldKey(bookId).length + 1) } : {}) }, before: null })) : saved;
        if (!changes.every(isChange)) throw new Error("Unreadable pending notes");
        const migrated = changes.map((change, index) => {
          const id = `legacy-${encodeURIComponent(key)}-${index}`;
          if (completed.has(id) || storage.getItem(`${prefix}${id}.done`) !== null) return null;
          const existing = outbox.find((entry) => entry.id === id);
          if (existing) { if (!existing.persisted) persist(existing); return existing; }
          const entry: PendingNote = { id, order: Math.max(0, ...outbox.map((pending) => pending.order)) + 1, change, persisted: false, rejected: false, legacySource: key };
          outbox.push(entry);
          persist(entry);
          return entry;
        });
        if (migrated.every((entry) => entry === null || entry.persisted) && storage.getItem(key) === source) {
          storage.removeItem(key);
          changes.forEach((_, index) => storage.removeItem(`${prefix}legacy-${encodeURIComponent(key)}-${index}.done`));
        }
      } catch {
        storageHealthy = false;
        legacyProblem = true;
      }
    }
  }

  reconcile();

  const current = (): Note[] => outbox.reduce((notes, entry) => applyNoteChange(notes, entry.change), kept);
  const state = (): NoteSyncState => ({
    phase: outbox.some((entry) => entry.rejected) ? "rejected" : !storageHealthy || legacyProblem ? "storage-unavailable" : phase,
    pending: outbox.length,
    durable: storageHealthy && !legacyProblem && outbox.every((entry) => entry.persisted),
    ...(reason ? { reason } : {}),
  });

  function report(): void {
    if (closed) return;
    const notes = current();
    const now = JSON.stringify(notes);
    if (now !== shown) { shown = now; onChange(notes); }
    const status = state();
    const statusText = JSON.stringify(status);
    if (statusText !== shownStatus) { shownStatus = statusText; options.onStatus?.(status); }
  }

  function prepareOutbox(): void {
    reconcile();
    migrate();
    let nextOrder = Math.max(0, ...outbox.filter((entry) => entry.persisted).map((entry) => entry.order));
    for (const entry of outbox.filter((entry) => !entry.persisted)) { entry.order = ++nextOrder; persist(entry); }
    outbox.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  async function append(work: () => void): Promise<void> {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (locks) await locks.request(`${outboxKey(owner, bookId)}.append`, work);
    else work();
  }

  /** Sends the waiting changes in order, and stops at one DeepRead cannot take now: it waits for the next try. */
  async function send(): Promise<void> {
    await append(prepareOutbox);
    if (outbox.some((entry) => entry.rejected)) { report(); return; }
    phase = outbox.length ? "saving" : phase;
    reason = undefined;
    report();
    while (outbox.length > 0 && !closed) {
      const entry = outbox[0]!;
      const { change } = entry;
      try {
        await server.changeNote(bookId, change);
        kept = applyNoteChange(kept, change);
      } catch (error) {
        const refused = error instanceof ApiFailure && error.status >= 400 && error.status < 500 && !NOT_NOW.includes(error.status);
        phase = refused ? "rejected" : "offline";
        reason = refused ? "refused" : error instanceof ApiFailure && error.status === 401 ? "sign-in" : "connection";
        if (refused) {
          entry.rejected = true;
          const pending = outbox.find((current) => current.id === entry.id);
          if (pending) pending.rejected = true;
          try { if (entry.persisted) storage?.setItem(rejectionKey(entry), "true"); } catch { storageHealthy = false; }
        }
        report();
        return;
      }
      outbox = outbox.filter((pending) => pending.id !== entry.id);
      completed.add(entry.id);
      try {
        const source = legacySourceKey(entry.id);
        if (source && storage?.getItem(source) !== null) storage?.setItem(`${operationKey(entry)}.done`, "true");
        storage?.removeItem(operationKey(entry)); storage?.removeItem(rejectionKey(entry));
      } catch {
        storageHealthy = false;
        // An acknowledgement must survive a reload even if this browser refuses to remove the old operation.
        try { storage?.setItem(`${operationKey(entry)}.done`, "true"); } catch { storageHealthy = false; }
      }
      await append(prepareOutbox);
      if (outbox.some((pending) => pending.rejected)) break;
    }
    if (!outbox.length) { phase = "saved"; reason = undefined; }
    report();
  }

  function queued(work: () => Promise<void>): Promise<void> {
    queue = queue.then(async () => {
      if (closed) return;
      // Web Locks orders mutation requests across tabs too, including migration and explicit recovery.
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      if (locks) await locks.request(outboxKey(owner, bookId), () => closed ? undefined : work());
      else await work();
    });
    return queue;
  }

  /** Sends the waiting changes, then takes the notes DeepRead has. */
  async function pull(): Promise<void> {
    await send();
    if (closed) return;
    try {
      kept = await server.getNotes(bookId);
      if (!outbox.length) { phase = "saved"; reason = undefined; }
      report();
    } catch (error) {
      if (!outbox.some((entry) => entry.rejected)) {
        phase = "offline";
        reason = error instanceof ApiFailure && error.status === 401 ? "sign-in" : "connection";
      }
      report();
    }
  }

  return {
    current,
    state,

    change(change) {
      if (closed) return Promise.resolve();
      reconcile();
      const entry: PendingNote = { id: crypto.randomUUID(), order: Math.max(0, ...outbox.map((pending) => pending.order)) + 1, change, persisted: false, rejected: false };
      outbox.push(entry);
      phase = "saving";
      report();
      // A short storage lock never waits for network I/O. Navigation stops sending, but must finish this append.
      appending = appending.then(() => append(() => { prepareOutbox(); report(); }));
      return appending.then(() => queued(send));
    },

    load() {
      if (closed) return Promise.resolve();
      report();
      return queued(pull);
    },

    refresh() {
      if (closed) return Promise.resolve();
      // A change made while this waits for DeepRead is in the outbox, so it still shows on top of what comes back.
      refreshing ??= queued(async () => {
        try {
          await pull();
        } finally {
          refreshing = null;
        }
      });
      return refreshing;
    },

    retry() {
      if (closed) return Promise.resolve();
      return queued(async () => {
        reconcile();
        for (const entry of outbox) {
          entry.rejected = false;
          try { storage?.removeItem(rejectionKey(entry)); } catch { storageHealthy = false; }
        }
        phase = "saving";
        await pull();
      });
    },

    discardRejected() {
      if (closed) return Promise.resolve();
      return queued(async () => {
        reconcile();
        for (const entry of outbox.filter((pending) => pending.rejected)) {
          try {
            const source = legacySourceKey(entry.id);
            if (source && storage?.getItem(source) !== null) storage?.setItem(`${operationKey(entry)}.done`, "true");
            storage?.removeItem(operationKey(entry)); storage?.removeItem(rejectionKey(entry));
          } catch { storageHealthy = false; continue; }
          outbox = outbox.filter((pending) => pending.id !== entry.id);
          completed.add(entry.id);
        }
        report();
        await pull();
      });
    },

    close() {
      closed = true;
    },
  };
}
