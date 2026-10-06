// Slows down guessing a profile's code: a few wrong tries in a row lock the one who sent them out for a while, and
// each further lock lasts twice as long. profiles.ts keeps one throttle per profile, keyed by who is trying, so wrong
// codes sent from one place never lock out the right reader somewhere else.
// Kept in memory, and handed out by snapshot() and taken back by restore() so profiles.ts can keep it in locks.json:
// otherwise a guesser who can restart DeepRead would get a fresh count each time.
// A key is forgotten by a right code, by its profile's removal, or after a day (the longest lock) without a wrong try.
// At most `maxKeys` are kept, so addresses made up by a guesser cannot fill the memory or the file.

import { isIPv6 } from "node:net";

/** What a key has done: the wrong tries since its last lock, how many locks it has had, when the current one ends and when it last tried wrong (epoch ms). */
export type ThrottleEntry = { wrong: number; locks: number; lockedUntil: number; last: number };

/** The entries of a throttle by key: plain data, so it survives JSON. */
export type ThrottleState = Record<string, ThrottleEntry>;

export type Throttle = {
  /** Milliseconds until `key` may try again; 0 when it may try now. */
  wait(key: string, now: number): number;
  /** Whether `key` has wrong tries or a lock counted. */
  tracks(key: string): boolean;
  /** Counts a wrong try. The last one allowed in a row locks `key`, twice as long as its lock before. */
  count(key: string, now: number): void;
  /** Forgets the tries and the locks of `key`: a right code from it. */
  clear(key: string): void;
  /** A copy of everything this throttle keeps. */
  snapshot(): ThrottleState;
  /** Takes back what `snapshot` gave, read from wherever it was kept: anything that is not a well-formed entry is skipped. */
  restore(saved: unknown, now: number): void;
};

export type ThrottleOptions = {
  /** Wrong tries in a row that lock a key. */
  tries: number;
  /** How long the first lock lasts. */
  lockMs: number;
  /** The longest any lock lasts, however many came before it. */
  maxLockMs: number;
  /** The most keys kept; 1000 unless said. */
  maxKeys?: number;
};

const MAX_KEYS = 1000;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Who sent a try, as far as counting goes: an IPv6 address stands for its /64, the part one connection owns and may
 * change address within at will, so changing it gives a guesser no fresh tries. IPv4 addresses and any other key stay as they are.
 */
export function clientKey(address: string): string {
  if (!isIPv6(address)) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  const [head = "", tail] = address.split("%")[0]!.split("::");
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const first = groups(head);
  // A dotted IPv4 ending takes the room of two groups, which is only ever past the first four.
  const last = groups(tail ?? "").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group]));
  const all = tail === undefined ? first : [...first, ...Array<string>(Math.max(0, 8 - first.length - last.length)).fill("0"), ...last];
  return `${all.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

export function createThrottle({ tries, lockMs, maxLockMs, maxKeys = MAX_KEYS }: ThrottleOptions): Throttle {
  // In the order of each key's last wrong try, the oldest first: counting moves a key to the end.
  const state = new Map<string, ThrottleEntry>();
  // Not forgotten while a lock lasts, and then for a day after the lock or the last wrong try: a guesser trying slowly still runs into the lock.
  const idle = (entry: ThrottleEntry, now: number): boolean => Math.max(entry.last, entry.lockedUntil) + maxLockMs <= now;
  const locked = (entry: ThrottleEntry, now: number): boolean => entry.lockedUntil > now;

  /** Drops the oldest keys while they are idle: cheap, as it stops at the first one that is not. */
  function forgetIdle(now: number): void {
    for (const [key, entry] of state) {
      if (!idle(entry, now)) return;
      state.delete(key);
    }
  }

  /** Makes room for one more key by dropping the oldest that is not locked. False when every key is locked: those are never dropped for a newer key. */
  function makeRoom(now: number): boolean {
    if (state.size < maxKeys) return true;
    for (const [key, entry] of state) {
      if (locked(entry, now)) continue;
      state.delete(key);
      return true;
    }
    return false;
  }

  return {
    wait(key, now) {
      const lockedUntil = state.get(key)?.lockedUntil ?? 0;
      return Math.max(0, lockedUntil - now);
    },
    tracks(key) {
      return state.has(key);
    },
    count(key, now) {
      forgetIdle(now);
      const found = state.get(key);
      state.delete(key);
      let entry: ThrottleEntry;
      if (found && !idle(found, now)) entry = found;
      // SHORTCUT: with every key locked a new key goes uncounted, as dropping a lock for it would help the guesser more; raise maxKeys if that ever happens to real readers.
      else if (makeRoom(now)) entry = { wrong: 0, locks: 0, lockedUntil: 0, last: now };
      else return;
      entry.wrong += 1;
      entry.last = now;
      if (entry.wrong >= tries) {
        entry.lockedUntil = now + Math.min(lockMs * 2 ** entry.locks, maxLockMs);
        entry.locks += 1;
        entry.wrong = 0;
      }
      state.set(key, entry);
    },
    clear(key) {
      state.delete(key);
    },
    snapshot() {
      return Object.fromEntries([...state].map(([key, entry]) => [key, { ...entry }]));
    },
    restore(saved, now) {
      if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return;
      const entries: Array<[string, ThrottleEntry]> = [];
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value !== "object" || value === null) continue;
        const { wrong, locks, lockedUntil, last } = value as Record<string, unknown>;
        if (!isCount(wrong) || !isCount(locks) || !isTime(lockedUntil) || !isTime(last)) continue;
        // Nothing ends or happens later than the longest lock or now: a later time is a clock that was set back, and would keep the key for good.
        const entry = { wrong, locks, lockedUntil: Math.min(lockedUntil, now + maxLockMs), last: Math.min(last, now) };
        if (!idle(entry, now)) entries.push([key, entry]);
      }
      // Oldest first, so the keys end up in the order counting keeps them in, and the newest are the ones kept when there are too many.
      for (const [key, entry] of entries.sort((a, b) => a[1].last - b[1].last)) {
        state.delete(key);
        if (makeRoom(now)) state.set(key, entry);
      }
    },
  };
}
