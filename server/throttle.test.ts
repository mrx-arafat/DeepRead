import { describe, expect, it } from "vitest";
import { clientKey, createThrottle } from "./throttle.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("createThrottle", () => {
  it("should lock a key after five wrong tries, twice as long each further time up to a day, until it is cleared", () => {
    const throttle = createThrottle({ tries: 5, lockMs: 5 * MINUTE, maxLockMs: 24 * 60 * MINUTE });
    let now = Date.parse("2026-10-06T10:00:00Z");
    const lockMinutes: number[] = [];
    for (let lock = 0; lock < 11; lock++) {
      for (let attempt = 1; attempt <= 4; attempt++) throttle.count("mina local", now);
      expect(throttle.wait("mina local", now)).toBe(0);
      throttle.count("mina local", now);
      const wait = throttle.wait("mina local", now);
      lockMinutes.push(wait / MINUTE);
      // Waiting it out does not forget the locks so far: only a right code does.
      now += wait;
    }
    expect(lockMinutes).toEqual([5, 10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440]);
    expect(throttle.wait("mina 203.0.113.7", now)).toBe(0);

    throttle.clear("mina local");
    for (let attempt = 1; attempt <= 5; attempt++) throttle.count("mina local", now);
    expect(throttle.wait("mina local", now)).toBe(5 * MINUTE);
  });

  it("should hold a lock, the tries before it and the length of the next lock in a new throttle until they run out", () => {
    const options = { tries: 5, lockMs: 5 * MINUTE, maxLockMs: 24 * 60 * MINUTE };
    const start = Date.parse("2026-10-06T10:00:00Z");
    const before = createThrottle(options);
    for (let attempt = 1; attempt <= 5; attempt++) before.count("mina local", start);
    for (let attempt = 1; attempt <= 3; attempt++) before.count("rafi local", start);

    // Through JSON, as locks.json carries it across a restart.
    const after = createThrottle(options);
    after.restore(JSON.parse(JSON.stringify(before.snapshot())), start + MINUTE);

    expect(after.wait("mina local", start + 4 * MINUTE)).toBe(MINUTE);
    expect(after.wait("mina local", start + 5 * MINUTE)).toBe(0);
    // Three wrong tries came before the restart, so two more lock rafi.
    after.count("rafi local", start + MINUTE);
    expect(after.wait("rafi local", start + MINUTE)).toBe(0);
    after.count("rafi local", start + MINUTE);
    expect(after.wait("rafi local", start + MINUTE)).toBe(5 * MINUTE);
    // Mina's first lock has run out, but the restart did not make her next one start over at 5 minutes.
    for (let attempt = 1; attempt <= 5; attempt++) after.count("mina local", start + 5 * MINUTE);
    expect(after.wait("mina local", start + 5 * MINUTE)).toBe(10 * MINUTE);

    // A key whose lock ended a day ago, with no wrong try since, is no longer worth keeping: nothing but a lock still counts for a day.
    const keysAt = (now: number): string[] => {
      const late = createThrottle(options);
      late.restore(JSON.parse(JSON.stringify(before.snapshot())), now);
      return Object.keys(late.snapshot());
    };
    expect(keysAt(start + 5 * MINUTE + DAY - 1)).toEqual(["mina local"]);
    expect(keysAt(start + 5 * MINUTE + DAY)).toEqual([]);
  });

  it("should restore only the well-formed entries of a saved state, whatever else it holds", () => {
    const throttle = createThrottle({ tries: 5, lockMs: 5 * MINUTE, maxLockMs: 24 * 60 * MINUTE });
    const now = Date.parse("2026-10-06T10:00:00Z");
    const fine = { wrong: 2, locks: 1, lockedUntil: now + MINUTE, last: now };
    const junked = [
      null,
      "locked",
      7,
      [fine],
      { "mina local": "locked" },
      { "mina local": { ...fine, wrong: -1 } },
      { "mina local": { ...fine, lockedUntil: "soon" } },
      { "mina local": { ...fine, last: undefined } },
    ];
    for (const junk of junked) {
      throttle.restore(junk, now);
      expect(throttle.snapshot()).toEqual({});
    }

    // A lock that ends further off than any lock lasts (a clock that was set back) is cut to the longest one.
    throttle.restore({ "mina local": fine, "rafi local": { ...fine, lockedUntil: now + 365 * 24 * 60 * MINUTE }, "kim local": 5 }, now);
    expect(Object.keys(throttle.snapshot()).sort()).toEqual(["mina local", "rafi local"]);
    expect(throttle.wait("mina local", now)).toBe(MINUTE);
    expect(throttle.wait("rafi local", now)).toBe(24 * 60 * MINUTE);

    // A try that is said to be in the future is cut to now too, or its key would outlive every other.
    const other = createThrottle({ tries: 5, lockMs: 5 * MINUTE, maxLockMs: DAY });
    other.restore({ "kim local": { wrong: 1, locks: 0, lockedUntil: 0, last: now + 7 * DAY } }, now);
    expect(other.snapshot()["kim local"]?.last).toBe(now);
  });

  it("should keep at most maxKeys keys, dropping the oldest one that is not locked and never a lock for a newer key", () => {
    const options = { tries: 5, lockMs: 5 * MINUTE, maxLockMs: DAY, maxKeys: 3 };
    const start = Date.parse("2026-10-06T10:00:00Z");
    const throttle = createThrottle(options);
    const keys = () => Object.keys(throttle.snapshot()).sort();
    for (let attempt = 1; attempt <= 5; attempt++) throttle.count("locked", start);
    throttle.count("a", start + 1);
    throttle.count("b", start + 2);
    throttle.count("c", start + 3);
    expect(keys()).toEqual(["b", "c", "locked"]);
    // A key that tries again is the newest, so the next one dropped is "c".
    throttle.count("b", start + 4);
    throttle.count("d", start + 5);
    expect(keys()).toEqual(["b", "d", "locked"]);

    // With every key locked there is nothing to drop: the new key is not counted, and no lock is lifted.
    const full = createThrottle({ ...options, maxKeys: 2 });
    for (const key of ["x", "y"]) for (let attempt = 1; attempt <= 5; attempt++) full.count(key, start);
    for (let attempt = 1; attempt <= 9; attempt++) full.count("z", start);
    expect(full.wait("z", start)).toBe(0);
    expect(full.wait("x", start)).toBe(5 * MINUTE);
    expect(full.wait("y", start)).toBe(5 * MINUTE);

    // The same limit holds for a saved state that holds more.
    const restored = createThrottle(options);
    restored.restore(JSON.parse(JSON.stringify({ ...throttle.snapshot(), e: { wrong: 1, locks: 0, lockedUntil: 0, last: start + 6 }, f: { wrong: 1, locks: 0, lockedUntil: 0, last: start + 7 } })), start + 8);
    expect(Object.keys(restored.snapshot()).sort()).toEqual(["e", "f", "locked"]);
  });

  it("should forget a key with wrong tries but no lock once it has been quiet for a day, so such keys cannot pile up", () => {
    const options = { tries: 5, lockMs: 5 * MINUTE, maxLockMs: DAY };
    const start = Date.parse("2026-10-06T10:00:00Z");
    const throttle = createThrottle(options);
    for (let attempt = 1; attempt <= 4; attempt++) throttle.count("slow", start);
    throttle.count("gone", start);
    throttle.count("recent", start + DAY - 1);
    // A day on, counting for anyone forgets the keys that were quiet that long, though none of them ever had a lock to end.
    throttle.count("other", start + DAY);
    expect(Object.keys(throttle.snapshot()).sort()).toEqual(["other", "recent"]);

    // Four wrong tries a day ago and four now do not add up to a lock.
    const slow = createThrottle(options);
    for (let attempt = 1; attempt <= 4; attempt++) slow.count("slow", start);
    for (let attempt = 1; attempt <= 4; attempt++) slow.count("slow", start + DAY);
    expect(slow.wait("slow", start + DAY)).toBe(0);

    // The same when a saved state is read back.
    const saved = JSON.parse(
      JSON.stringify({
        slow: { wrong: 4, locks: 0, lockedUntil: 0, last: start },
        recent: { wrong: 1, locks: 0, lockedUntil: 0, last: start + DAY - 1 },
      }),
    );
    const readAt = (now: number): string[] => {
      const reread = createThrottle(options);
      reread.restore(saved, now);
      return Object.keys(reread.snapshot()).sort();
    };
    expect(readAt(start + DAY - 1)).toEqual(["recent", "slow"]);
    expect(readAt(start + DAY)).toEqual(["recent"]);
    expect(readAt(start + 2 * DAY - 1)).toEqual([]);
  });
});

describe("clientKey", () => {
  it("should stand for an IPv6 address by its /64, and leave IPv4 addresses and other keys as they are", () => {
    // Anything inside one /64 is one client: a household's address privacy rotates through them.
    expect(clientKey("2001:db8:0:1:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:0:1::/64");
    expect(clientKey("2001:0DB8:0:1::7")).toBe("2001:db8:0:1::/64");
    expect(clientKey("2001:db8::5")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(clientKey("2001:db8:0:2::1")).not.toBe(clientKey("2001:db8:0:1::1"));

    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    for (const other of ["203.0.113.7", "local", "mina local", "", "2001:db8::zz"]) expect(clientKey(other)).toBe(other);
  });
});
