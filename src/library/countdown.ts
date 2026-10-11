/**
 * A countdown that can be held: the time left, and when it last started running (null while held). Pure, so the
 * upload card's "Opening in 3 s" can pause under the reader's pointer and pick up exactly where it stopped.
 */
export interface Countdown {
  left: number;
  since: number | null;
}

export function startCountdown(ms: number, at: number, held: boolean): Countdown {
  return { left: ms, since: held ? null : at };
}

export function holdCountdown(countdown: Countdown, at: number): Countdown {
  return countdown.since === null ? countdown : { left: countdown.left - (at - countdown.since), since: null };
}

export function releaseCountdown(countdown: Countdown, at: number): Countdown {
  return countdown.since === null ? { ...countdown, since: at } : countdown;
}

/** The milliseconds still to go at `at`, never below zero. */
export function countdownLeft(countdown: Countdown, at: number): number {
  return Math.max(0, countdown.since === null ? countdown.left : countdown.left - (at - countdown.since));
}
