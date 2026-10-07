// Who reads here when ADMIN_PASSKEY is set. profiles.json at the root of the store lists the profiles, and each one keeps
// a library of its own under profiles/<id>/, so books, notes and answers never mix.
// The list is small and this DeepRead is the one that writes it, so it is kept in memory; every change still re-reads
// profiles.json, changes it and writes it back whole, one change at a time.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AI_PROVIDERS, AVATAR_PRESETS, isAiProviderId } from "../shared/types.ts";
import type { AdminProfile, AiProviderId, AvatarPreset, NewProfile, ProfileUpdate, PublicProfile } from "../shared/types.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import type { Photo } from "./avatar.ts";
import { hashCode, samePasskey, verifyCode } from "./codes.ts";
import { copyBooks } from "./copy-books.ts";
import { isRecord } from "./http.ts";
import { createLibrary, isBookId, slugify } from "./library.ts";
import type { Library, SharedLimit } from "./library.ts";
import { createShares, readerShelf } from "./shares.ts";
import type { Shares } from "./shares.ts";
import { scopedStore } from "./storage.ts";
import type { ObjectStore, StoredObject } from "./storage.ts";
import { clientKey, createThrottle } from "./throttle.ts";
import type { Throttle, ThrottleState } from "./throttle.ts";

/** A profile as profiles.json keeps it. */
export type StoredProfile = {
  id: string;
  name: string;
  admin: boolean;
  /** What the admin chose to label this profile with; absent for none (the admin's then shows "Admin"). */
  badge?: string;
  /** The AI helpers the admin gave this profile; absent for none. The admin's own profile uses every helper that works. */
  aiAccess?: AiProviderId[];
  /** Which of those the reader prefers. */
  aiChoice?: AiProviderId;
  /** The helpers this profile has asked for and the admin has not answered, each with when it asked. */
  aiRequests?: Partial<Record<AiProviderId, string>>;
  preset: AvatarPreset;
  /** Changes with every new photo; null without one. */
  photo: string | null;
  /** The code's scrypt hash (codes.ts). Null for the admin, whose code is ADMIN_PASSKEY. */
  codeHash: string | null;
  /** Moves on when the code changes, which ends every session opened with the old one. */
  sessionVersion: number;
  createdAt: string;
};

export type SignIn =
  | { outcome: "signed_in"; profile: StoredProfile }
  | { outcome: "not_found" }
  | { outcome: "wrong_code" }
  | { outcome: "locked"; minutes: number };

/** A change the rules do not allow, such as a name another profile has. The message says what to do instead. */
export class ProfileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

export const MAX_NAME_CHARS = 40;
export const MAX_BADGE_CHARS = 20;
// Six, so a guesser held to 5 tries per lock (each lock twice as long) cannot get through them in any useful time.
export const MIN_CODE_CHARS = 6;
export const MAX_CODE_CHARS = 64;
/** The longest code a sign-in reads: the admin's is ADMIN_PASSKEY, which may well be longer than a profile's code. */
export const MAX_PASSKEY_CHARS = 1024;
/** Below this an ADMIN_PASSKEY, which opens every profile, is easy to guess. */
export const STRONG_PASSKEY_CHARS = 12;

const PROFILES_KEY = "profiles.json";
/** Where a library keeps when each of its books was pinned (library.ts). */
const PINS_KEY = "pins.json";
// In the data folder on this computer, never in the store: the locks belong to this server, which counts the tries it saw.
const LOCKS_FILE = "locks.json";
const ADMIN_PRESET: AvatarPreset = "smile-blue";
const PHOTO_FILES: Record<Photo["type"], string> = { "image/webp": "avatar.webp", "image/jpeg": "avatar.jpg" };
const BOOK_OBJECT = /^profiles\/([^/]+)\/books\/([^/]+)\/(.+)$/;
// Five wrong codes in a row lock a profile's sign-in for whoever sent them: for 5 minutes, then twice as long each
// further time, up to a day.
const WRONG_TRIES = 5;
const LOCK_MS = 5 * 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;

/** Profile ids are a slug of the name plus random hex, and are checked like book ids before they reach the store. */
export const isProfileId = (id: string): boolean => isBookId(id);

export function isAvatarPreset(value: unknown): value is AvatarPreset {
  return typeof value === "string" && (AVATAR_PRESETS as readonly string[]).includes(value);
}

export function publicProfile(profile: StoredProfile): PublicProfile {
  return {
    id: profile.id,
    name: profile.name,
    avatar: { preset: profile.preset, photo: profile.photo },
    admin: profile.admin,
    badge: profile.badge ?? (profile.admin ? "Admin" : null),
  };
}

function isStoredProfile(value: unknown): value is StoredProfile {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isProfileId(value.id) &&
    typeof value.name === "string" &&
    typeof value.admin === "boolean" &&
    (value.badge === undefined || typeof value.badge === "string") &&
    (value.aiAccess === undefined || (Array.isArray(value.aiAccess) && value.aiAccess.every(isAiProviderId))) &&
    (value.aiChoice === undefined || isAiProviderId(value.aiChoice)) &&
    (value.aiRequests === undefined || (isRecord(value.aiRequests) && Object.keys(value.aiRequests).every(isAiProviderId))) &&
    isAvatarPreset(value.preset) &&
    (value.photo === null || typeof value.photo === "string") &&
    (value.codeHash === null || typeof value.codeHash === "string") &&
    Number.isInteger(value.sessionVersion) &&
    typeof value.createdAt === "string"
  );
}

/** Helpers in the order AI_PROVIDERS lists them, each once. */
const inProviderOrder = (ids: Iterable<AiProviderId>): AiProviderId[] => {
  const wanted = new Set(ids);
  return (Object.keys(AI_PROVIDERS) as AiProviderId[]).filter((id) => wanted.has(id));
};

/** Names are unique whatever their case: "Mina" and "mina" would be one face on the picker. */
const sameName = (a: string, b: string): boolean => a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();

/** The admin first, then everyone in the order they were added. */
const pickerOrder = (a: StoredProfile, b: StoredProfile): number =>
  Number(b.admin) - Number(a.admin) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const totalSize = (objects: StoredObject[]): number => objects.reduce((sum, object) => sum + object.size, 0);

/** Runs the works given to it one after another, each starting once the one before has settled. */
function createQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}

export type ProfilesOptions = {
  /** The whole store: profiles.json and profiles/ sit at its root. */
  store: ObjectStore;
  /** The data folder on this computer: uploads pass through <dataDir>/tmp/<profile id>. */
  dataDir: string;
  /** The most bytes everyone's books may take together; null for no limit. */
  limit: number | null;
  adminPasskey: string;
  /** What the admin's profile is called when it is first made. */
  adminName: string;
};

export type Profiles = {
  /**
   * Reads profiles.json, makes the admin's profile when there is none, and moves the books of the library from before
   * profiles into it. Every other method waits for this, so calling it first only moves the work to startup.
   */
  open(): Promise<void>;
  /** In picker order: the admin first, then by when they were added. */
  list(): Promise<StoredProfile[]>;
  find(id: string): Promise<StoredProfile | null>;
  /**
   * Checks a code. `client` is who sent it (routes-session.ts): after too many wrong codes from one client, that client is
   * locked out of the profile for a while, whatever code it sends next, while everyone else may still sign in.
   */
  signIn(id: string, code: string, client: string): Promise<SignIn>;
  /** The caller has validated the fields. Throws ProfileError when the name is taken. */
  create(profile: NewProfile): Promise<StoredProfile>;
  /** The caller has validated and trimmed `patch`. Null when there is no such profile; throws ProfileError. */
  update(id: string, patch: ProfileUpdate): Promise<StoredProfile | null>;
  /** The reader's own pick among the helpers they may use; null forgets it. Null when there is no such profile. */
  setAiChoice(id: string, choice: AiProviderId | null): Promise<StoredProfile | null>;
  /** The reader asks the admin for a helper. Asking again keeps the first time. Null when there is no such profile. */
  requestAi(id: string, helper: AiProviderId): Promise<StoredProfile | null>;
  /**
   * Gives the profile one more helper and answers its request for it, as one change: two approvals at the same moment both stand.
   * Null when there is no such profile; throws ProfileError for the admin's, which can use everything that works.
   */
  grantAi(id: string, helper: AiProviderId): Promise<StoredProfile | null>;
  /** Removes the profile and everything it keeps. False when there is none; throws ProfileError for the admin's. */
  remove(id: string): Promise<boolean>;
  /** Ends every session of the profile; its code still opens new ones. False when there is none; throws ProfileError for the admin's. */
  signOut(id: string): Promise<boolean>;
  setPhoto(id: string, photo: Photo): Promise<StoredProfile | null>;
  removePhoto(id: string): Promise<StoredProfile | null>;
  /** Null when the profile has no photo. */
  photo(id: string): Promise<Photo | null>;
  /** The profile's own library, made once and kept until the profile is removed. */
  library(id: string): Library;
  /** What the profile reads: its own library with the books other profiles share with it alongside. */
  shelf(id: string): Library;
  /** Who shares which book with whom. */
  shares: Shares;
  /** The profiles as the admin dashboard shows them: with how many books each keeps and the room they take. */
  describe(profiles: StoredProfile[]): Promise<AdminProfile[]>;
  /** Waits for the sign-in locks to be on disk (locks.json). Signing in does not wait for them; call this before DeepRead stops. */
  flush(): Promise<void>;
};

export function createProfiles(options: ProfilesOptions): Profiles {
  const { store, dataDir, limit, adminPasskey, adminName } = options;
  const tempRoot = join(dataDir, "tmp");
  const libraries = new Map<string, Library>();
  const shelves = new Map<string, Library>();
  const shares = createShares(store);
  // One per profile, keyed by client, so removing a profile forgets its tries in one step.
  const throttles = new Map<string, Throttle>();
  const locksFile = join(dataDir, LOCKS_FILE);
  // What locks.json holds as far as this server knows. A write that would leave it as it is is skipped.
  let writtenLocks = "";
  // Set when the locks changed and a write is due: the dirty flag, so that signing in never serializes them itself.
  let lockWriteQueued = false;
  let savingLocks: Promise<void> = Promise.resolve();
  const changes = createQueue();
  let profiles: StoredProfile[] = [];

  const throttleOf = (id: string): Throttle => {
    let throttle = throttles.get(id);
    if (!throttle) {
      throttle = createThrottle({ tries: WRONG_TRIES, lockMs: LOCK_MS, maxLockMs: MAX_LOCK_MS });
      throttles.set(id, throttle);
    }
    return throttle;
  };

  // Only profile ids, client keys, counts and times: nothing that opens a profile.
  function lockState(): string {
    const locks: Record<string, ThrottleState> = {};
    for (const [id, throttle] of throttles) {
      const state = throttle.snapshot();
      if (Object.keys(state).length > 0) locks[id] = state;
    }
    return JSON.stringify({ profiles: locks });
  }

  /**
   * Asks for locks.json to be written. Cheap and not awaited: the locks are serialized when the write runs, so tries that
   * arrive together share one write, and a failed write only warns and never changes a sign-in.
   */
  function saveLocks(): void {
    // One at a time, so an older state never lands last; the write already queued takes the state as it is when it starts.
    if (lockWriteQueued) return;
    lockWriteQueued = true;
    savingLocks = savingLocks.then(async () => {
      lockWriteQueued = false;
      let writing = "";
      try {
        writing = lockState();
        if (writing === writtenLocks) return;
        writtenLocks = writing;
        await writeFileAtomic(locksFile, `${writing}\n`, 0o600);
      } catch (error) {
        // Forgotten, so the next change writes again even if it leaves the same locks.
        if (writtenLocks === writing) writtenLocks = "";
        console.warn(`could not save the sign-in locks to ${LOCKS_FILE}, so a restart would lift them:`, error);
      }
    });
  }

  /** Takes the locks of the last run back from locks.json. A file that is missing or damaged means no locks, never a server that will not start. */
  async function restoreLocks(): Promise<void> {
    let saved: unknown = null;
    try {
      saved = JSON.parse(await readFile(locksFile, "utf8"));
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!missing) console.warn(`could not read ${LOCKS_FILE}, so every sign-in starts with no wrong tries counted:`, error);
    }
    const stored = isRecord(saved) && isRecord(saved.profiles) ? saved.profiles : {};
    const now = Date.now();
    // Only profiles that are still here: a removal that stopped before the file was saved leaves nothing behind.
    for (const profile of profiles) throttleOf(profile.id).restore(stored[profile.id], now);
    writtenLocks = lockState();
  }

  const storeOf = (id: string): ObjectStore => {
    if (!isProfileId(id)) throw new Error(`invalid profile id: ${JSON.stringify(id)}`);
    return scopedStore(store, `profiles/${id}/`);
  };

  const shared: SharedLimit = {
    total: async () => totalSize(await store.list("profiles/")),
    adding: createQueue(),
  };

  async function readProfiles(): Promise<StoredProfile[]> {
    const data = await store.read(PROFILES_KEY);
    if (!data) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      parsed = null;
    }
    const list = isRecord(parsed) ? parsed.profiles : null;
    // Never treated as empty: writing over it would lose every profile, and with them the way to their books.
    if (!Array.isArray(list) || !list.every(isStoredProfile)) {
      throw new Error(`${PROFILES_KEY} is damaged, so the profiles cannot be read. Restore it from a copy, or mend it by hand.`);
    }
    return list;
  }

  /** Reads profiles.json afresh, lets `edit` change the list, and writes it back whole when it did. Runs only inside `changes`. */
  async function rewrite<T>(edit: (current: StoredProfile[]) => Promise<[StoredProfile[], T]> | [StoredProfile[], T]): Promise<T> {
    const current = await readProfiles();
    const [next, result] = await edit(current);
    if (next !== current) await store.write(PROFILES_KEY, JSON.stringify({ profiles: next }, null, 2));
    profiles = next;
    return result;
  }

  function newId(name: string, taken: StoredProfile[]): string {
    for (;;) {
      const id = `${slugify(name, "reader")}-${randomBytes(3).toString("hex")}`;
      if (!taken.some((profile) => profile.id === id)) return id;
    }
  }

  function assertNameFree(current: StoredProfile[], name: string, except?: string): void {
    const holder = current.find((profile) => profile.id !== except && sameName(profile.name, name));
    if (holder) throw new ProfileError("name_taken", `There is already a profile called ${holder.name}. Choose another name.`);
  }

  const replace = (current: StoredProfile[], next: StoredProfile): StoredProfile[] =>
    current.map((profile) => (profile.id === next.id ? next : profile));

  /**
   * The books from before profiles were turned on sit in books/ at the root. They become the admin's: copied into the
   * admin's library (meta.json last), and each removed from the root only once this run has copied it, so a stop at any
   * moment loses nothing. A book whose id the admin's profile already has is left where it is: the same PDF, but its
   * notes, place and answers may differ from the admin's copy, and only the user can say which to keep.
   */
  async function moveSingleLibrary(admin: StoredProfile): Promise<void> {
    if ((await store.list("books/")).length === 0) return;
    const target = storeOf(admin.id);
    const tempDir = join(tempRoot, "moving");
    await mkdir(tempDir, { recursive: true });
    try {
      const { copied, skipped } = await copyBooks(store, target, { tempDir, limit: null });
      for (const id of copied) await store.removeAll(`books/${id}/`);
      // The pins go with the books. The admin's own pins, if they somehow have some, are kept as they are.
      const pins = await store.read(PINS_KEY);
      if (pins) {
        if ((await target.size(PINS_KEY)) === null) await target.write(PINS_KEY, pins);
        await store.remove([PINS_KEY]);
      }
      const books = (ids: string[]): string => `${ids.length} book${ids.length === 1 ? "" : "s"} from before profiles`;
      if (copied.length > 0) console.log(`Moved ${books(copied)} into ${admin.name}'s profile: ${copied.join(", ")}.`);
      if (skipped.length > 0) {
        console.log(`Kept ${books(skipped)} in books/, because ${admin.name}'s profile already has a book with the same id: ${skipped.join(", ")}.`);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  let opened: Promise<void> | null = null;
  const open = (): Promise<void> =>
    (opened ??= (async () => {
      // Nothing has passed through tmp/ yet, so whatever is there was left by an earlier run.
      await rm(tempRoot, { recursive: true, force: true });
      const admin = await changes(() =>
        rewrite((current): [StoredProfile[], StoredProfile] => {
          const existing = current.find((profile) => profile.admin);
          if (existing) return [current, existing];
          const made: StoredProfile = {
            id: newId(adminName, current),
            name: adminName,
            admin: true,
            preset: ADMIN_PRESET,
            photo: null,
            codeHash: null,
            sessionVersion: 1,
            createdAt: new Date().toISOString(),
          };
          return [[...current, made], made];
        }),
      );
      await moveSingleLibrary(admin);
      await restoreLocks();
    })().catch((error: unknown) => {
      opened = null;
      throw error;
    }));

  function libraryOf(id: string): Library {
    let library = libraries.get(id);
    if (!library) {
      // Each its own temp folder: a library empties its folder on first use, which must not touch another's upload.
      library = createLibrary(dataDir, { store: storeOf(id), limit, tempDir: join(tempRoot, id), shared });
      libraries.set(id, library);
    }
    return library;
  }

  function shelfOf(id: string): Library {
    let shelf = shelves.get(id);
    if (!shelf) {
      const existing = (profileId: string) => profiles.find((profile) => profile.id === profileId);
      shelf = readerShelf(libraryOf(id), id, {
        store,
        shares,
        libraryOf: (owner) => (existing(owner) ? libraryOf(owner) : null),
        profileOf: (profileId) => {
          const profile = existing(profileId);
          return profile ? publicProfile(profile) : null;
        },
      });
      shelves.set(id, shelf);
    }
    return shelf;
  }

  async function find(id: string): Promise<StoredProfile | null> {
    await open();
    return profiles.find((profile) => profile.id === id) ?? null;
  }

  return {
    open,

    async list() {
      await open();
      return [...profiles].sort(pickerOrder);
    },

    find,

    async signIn(id, code, client) {
      const profile = await find(id);
      if (!profile) return { outcome: "not_found" };
      const throttle = throttleOf(id);
      // An IPv6 address counts as its /64, so a guesser cannot get fresh tries by changing address within it.
      const who = clientKey(client);
      const now = Date.now();
      const wait = throttle.wait(who, now);
      if (wait > 0) return { outcome: "locked", minutes: Math.ceil(wait / 60_000) };
      const hadTries = throttle.tracks(who);
      // Counted before the code is checked: tries sent all at once would otherwise all pass the lock while scrypt runs.
      throttle.count(who, now);
      // Saved before the check too when this try locked the client, so a stop while scrypt runs does not lift the lock.
      const locked = throttle.wait(who, now) > 0;
      if (locked) saveLocks();
      const right = profile.admin
        ? samePasskey(code, adminPasskey)
        : profile.codeHash !== null && (await verifyCode(code, profile.codeHash));
      if (!right) {
        saveLocks();
        return { outcome: "wrong_code" };
      }
      throttle.clear(who);
      // A client with no wrong tries before leaves the file as it was: nothing is written then.
      if (hadTries || locked) saveLocks();
      return { outcome: "signed_in", profile };
    },

    async create({ name, code, preset, badge }) {
      await open();
      // Hashed before queueing: scrypt is slow on purpose, and other changes need not wait for it.
      const codeHash = await hashCode(code);
      return changes(() =>
        rewrite((current): [StoredProfile[], StoredProfile] => {
          assertNameFree(current, name);
          const made: StoredProfile = {
            id: newId(name, current),
            name,
            admin: false,
            ...(badge && { badge }),
            preset,
            photo: null,
            codeHash,
            sessionVersion: 1,
            createdAt: new Date().toISOString(),
          };
          return [[...current, made], made];
        }),
      );
    },

    async update(id, patch) {
      const adminCode = new ProfileError(
        "admin_code",
        "The admin's code is ADMIN_PASSKEY. To change it, change ADMIN_PASSKEY in .env and start DeepRead again.",
      );
      if (patch.code !== undefined && (await find(id))?.admin) throw adminCode;
      const codeHash = patch.code === undefined ? null : await hashCode(patch.code);
      return changes(() =>
        rewrite((current): [StoredProfile[], StoredProfile | null] => {
          const profile = current.find((candidate) => candidate.id === id);
          if (!profile) return [current, null];
          if (codeHash !== null && profile.admin) throw adminCode;
          if (patch.name !== undefined) assertNameFree(current, patch.name, id);
          const next: StoredProfile = {
            ...profile,
            name: patch.name ?? profile.name,
            preset: patch.preset ?? profile.preset,
            // A new code signs this profile out everywhere.
            ...(codeHash !== null && { codeHash, sessionVersion: profile.sessionVersion + 1 }),
          };
          if (patch.badge === "") delete next.badge;
          else if (patch.badge !== undefined) next.badge = patch.badge;
          if (patch.ai !== undefined) {
            if (profile.admin) {
              throw new ProfileError("admin_ai", "The admin can use every AI helper that works, so there is nothing to give.");
            }
            const access = inProviderOrder(patch.ai);
            if (access.length === 0) delete next.aiAccess;
            else next.aiAccess = access;
            if (next.aiChoice && !access.includes(next.aiChoice)) delete next.aiChoice;
          }
          // Giving a helper answers a request for it, and so does turning it down.
          const asked = { ...next.aiRequests };
          for (const helper of [...(patch.ai ?? []), ...(patch.aiDismiss ?? [])]) delete asked[helper];
          if (Object.keys(asked).length === 0) delete next.aiRequests;
          else next.aiRequests = asked;
          return [replace(current, next), next];
        }),
      );
    },

    async setAiChoice(id, choice) {
      await open();
      return changes(() =>
        rewrite((current): [StoredProfile[], StoredProfile | null] => {
          const profile = current.find((candidate) => candidate.id === id);
          if (!profile) return [current, null];
          const next: StoredProfile = { ...profile };
          if (choice === null) delete next.aiChoice;
          else next.aiChoice = choice;
          return [replace(current, next), next];
        }),
      );
    },

    async grantAi(id, helper) {
      await open();
      return changes(() =>
        rewrite((current): [StoredProfile[], StoredProfile | null] => {
          const profile = current.find((candidate) => candidate.id === id);
          if (!profile) return [current, null];
          if (profile.admin) {
            throw new ProfileError("admin_ai", "The admin can use every AI helper that works, so there is nothing to give.");
          }
          const next: StoredProfile = { ...profile, aiAccess: inProviderOrder([...(profile.aiAccess ?? []), helper]) };
          const asked = { ...profile.aiRequests };
          delete asked[helper];
          if (Object.keys(asked).length === 0) delete next.aiRequests;
          else next.aiRequests = asked;
          return [replace(current, next), next];
        }),
      );
    },

    async requestAi(id, helper) {
      await open();
      return changes(() =>
        rewrite((current): [StoredProfile[], StoredProfile | null] => {
          const profile = current.find((candidate) => candidate.id === id);
          if (!profile) return [current, null];
          if (profile.aiRequests?.[helper]) return [current, profile];
          const next: StoredProfile = { ...profile, aiRequests: { ...profile.aiRequests, [helper]: new Date().toISOString() } };
          return [replace(current, next), next];
        }),
      );
    },

    async remove(id) {
      await open();
      const removed = await changes(() =>
        rewrite((current): [StoredProfile[], boolean] => {
          const profile = current.find((candidate) => candidate.id === id);
          if (!profile) return [current, false];
          if (profile.admin) throw new ProfileError("admin_profile", "The admin's profile cannot be removed.");
          // Out of the list first: the profile, its sign-in and its sessions are gone in one step, its files after.
          return [current.filter((candidate) => candidate.id !== id), true];
        }),
      );
      if (!removed) return false;
      if (throttles.delete(id)) saveLocks();
      // A request that began before the removal may hold this library, or be about to ask for it, with an upload or a
      // save under way: closed, it finishes what has started and refuses the rest, so nothing is written back once the
      // files are cleared. Made if there is none yet, so a late caller gets this closed one rather than a fresh one.
      // Outside `changes` and every queue of the library, so the wait cannot be stuck behind itself.
      await libraryOf(id).close();
      try {
        await store.removeAll(`profiles/${id}/`);
      } catch (error) {
        // Nothing can reach these files any more; they only take room until they are cleared by hand.
        console.warn(`could not clear away all the files of removed profile ${id}:`, error);
      }
      libraries.delete(id);
      shelves.delete(id);
      // What it shared and what was shared with it end with it.
      await shares.forgetProfile(id);
      return true;
    },

    async signOut(id) {
      await open();
      return changes(() =>
        rewrite((current): [StoredProfile[], boolean] => {
          const profile = current.find((candidate) => candidate.id === id);
          if (!profile) return [current, false];
          if (profile.admin) {
            throw new ProfileError(
              "admin_profile",
              "The admin's sessions end when ADMIN_PASSKEY changes. To sign the admin out everywhere, change ADMIN_PASSKEY in .env and start DeepRead again.",
            );
          }
          // Sessions carry the sessionVersion they began with (session-token.ts), so moving it on ends them all.
          return [replace(current, { ...profile, sessionVersion: profile.sessionVersion + 1 }), true];
        }),
      );
    },

    async setPhoto(id, photo) {
      await open();
      return changes(() =>
        rewrite(async (current): Promise<[StoredProfile[], StoredProfile | null]> => {
          const profile = current.find((candidate) => candidate.id === id);
          if (!profile) return [current, null];
          // The picture first, so profiles.json never promises a photo that is not there.
          const own = storeOf(id);
          await own.write(PHOTO_FILES[photo.type], photo.data);
          await own.remove(Object.values(PHOTO_FILES).filter((name) => name !== PHOTO_FILES[photo.type]));
          const next = { ...profile, photo: randomBytes(6).toString("hex") };
          return [replace(current, next), next];
        }),
      );
    },

    async removePhoto(id) {
      await open();
      return changes(async () => {
        // profiles.json first, so it never promises a photo that is already gone; in the queue, so a new photo cannot land in between.
        const next = await rewrite((current): [StoredProfile[], StoredProfile | null] => {
          const profile = current.find((candidate) => candidate.id === id);
          if (!profile) return [current, null];
          const updated = { ...profile, photo: null };
          return [replace(current, updated), updated];
        });
        if (next) await storeOf(id).remove(Object.values(PHOTO_FILES));
        return next;
      });
    },

    async photo(id) {
      const profile = await find(id);
      if (!profile?.photo) return null;
      for (const [type, name] of Object.entries(PHOTO_FILES) as Array<[Photo["type"], string]>) {
        const data = await storeOf(id).read(name);
        if (data) return { data: new Uint8Array(data), type };
      }
      return null;
    },

    library: libraryOf,
    shelf: shelfOf,
    shares,

    async describe(list) {
      // One listing for the whole dashboard; one profile's folder when only that profile is asked about.
      const only = list.length === 1 ? list[0] : undefined;
      const objects = await store.list(only ? `profiles/${only.id}/books/` : "profiles/");
      const shelves = new Map<string, { bookCount: number; used: number }>();
      for (const { key, size } of objects) {
        const [, id = "", bookId = "", file] = BOOK_OBJECT.exec(key) ?? [];
        if (!file) continue;
        const shelf = shelves.get(id) ?? { bookCount: 0, used: 0 };
        shelf.used += size;
        // A book is in the library exactly while its meta.json is (library.ts).
        if (file === "meta.json" && isBookId(bookId)) shelf.bookCount += 1;
        shelves.set(id, shelf);
      }
      return list.map((profile) => ({
        ...publicProfile(profile),
        ai: profile.aiAccess ?? [],
        aiRequested: inProviderOrder(Object.keys(profile.aiRequests ?? {}).filter(isAiProviderId)),
        createdAt: profile.createdAt,
        bookCount: shelves.get(profile.id)?.bookCount ?? 0,
        used: shelves.get(profile.id)?.used ?? 0,
      }));
    },

    async flush() {
      // A write that began while this waited is queued behind the one waited for.
      for (let tail = savingLocks; ; tail = savingLocks) {
        await tail;
        if (tail === savingLocks) return;
      }
    },
  };
}
