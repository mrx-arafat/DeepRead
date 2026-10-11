import { describe, expect, it } from "vitest";
import { countdownLeft, holdCountdown, releaseCountdown, startCountdown } from "./countdown.ts";

describe("countdown", () => {
  it("should run down with time and stop at zero", () => {
    const countdown = startCountdown(4000, 1000, false);

    expect(countdownLeft(countdown, 2500)).toBe(2500);
    expect(countdownLeft(countdown, 9000)).toBe(0);
  });

  it("should keep the time left while held and carry on from it when released", () => {
    const held = holdCountdown(startCountdown(4000, 0, false), 1000);

    expect(countdownLeft(held, 60_000)).toBe(3000);
    expect(countdownLeft(releaseCountdown(held, 60_000), 61_000)).toBe(2000);
  });

  it("should not start running when it begins held", () => {
    const countdown = startCountdown(4000, 0, true);

    expect(countdownLeft(countdown, 10_000)).toBe(4000);
    expect(countdownLeft(releaseCountdown(countdown, 10_000), 11_000)).toBe(3000);
  });
});
