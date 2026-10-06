// What a wrong code is answered with. The server says only that the code is wrong; the page has some fun with it.

export const WRONG_CODE_LINES = [
  "Nope. That is not the code. Nice try, though.",
  "Wrong. Snooping in someone's books? Bold.",
  "Wrong. The bouncer laughed out loud.",
  "Not even close. Try the code you own.",
  "Wrong. Guessing is not a reading skill.",
  "That opens nothing. Detective career over.",
  "Nope. The books are judging you.",
  "Wrong code. Bold of you to guess.",
  "Access denied. Dramatic pause. Try again.",
  "Wrong code. The library cat is disappointed.",
] as const;

/** A line for a wrong code, never the same one twice in a row (`previous` is the last one shown). */
export function wrongCodeLine(previous: string | null, random: () => number = Math.random): string {
  const choices = WRONG_CODE_LINES.filter((line) => line !== previous);
  return choices[Math.min(Math.floor(random() * choices.length), choices.length - 1)] ?? WRONG_CODE_LINES[0];
}
