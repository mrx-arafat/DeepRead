// Slows down guessing a profile's code: a few wrong tries in a row lock the one who sent them out for a while, and
// each further lock lasts twice as long. profiles.ts keeps one throttle per profile, keyed by who is trying, so wrong
// codes sent from one place never lock out the right reader somewhere else.
// Kept in memory: a restart opens every profile again, which costs a guesser a restart they cannot cause.
// SHORTCUT: a key is kept until a right code, a restart or its profile's removal; forget idle keys if many addresses ever guess.

export type Throttle = {
  /** Milliseconds until `key` may try again; 0 when it may try now. */
  wait(key: string, now: number): number;
  /** Counts a wrong try. The last one allowed in a row locks `key`, twice as long as its lock before. */
  count(key: string, now: number): void;
  /** Forgets the tries and the locks of `key`: a right code from it. */
  clear(key: string): void;
};

export type ThrottleOptions = {
  /** Wrong tries in a row that lock a key. */
  tries: number;
  /** How long the first lock lasts. */
  lockMs: number;
  /** The longest any lock lasts, however many came before it. */
  maxLockMs: number;
};

export function createThrottle({ tries, lockMs, maxLockMs }: ThrottleOptions): Throttle {
  const state = new Map<string, { wrong: number; locks: number; lockedUntil: number }>();
  return {
    wait(key, now) {
      const lockedUntil = state.get(key)?.lockedUntil ?? 0;
      return Math.max(0, lockedUntil - now);
    },
    count(key, now) {
      const entry = state.get(key) ?? { wrong: 0, locks: 0, lockedUntil: 0 };
      entry.wrong += 1;
      // Not forgotten with time, only by a right code: a guesser trying slowly still runs into the lock.
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
  };
}
