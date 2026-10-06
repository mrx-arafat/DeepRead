import { describe, expect, it } from "vitest";
import { createThrottle } from "./throttle.ts";

const MINUTE = 60_000;

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
});
