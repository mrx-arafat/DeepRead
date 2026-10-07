import type { AiStatus } from "../../shared/types.ts";

/**
 * The line under the selection bar for a reader the admin has given an AI helper, so the gift is seen as one.
 * It names neither the admin nor the helper. Null for the admin and for a library without profiles, who are not being
 * given anything, and while nothing answers.
 */
export function helperCredit(status: AiStatus | null, isReader: boolean): string | null {
  if (!isReader || !status?.owner || !status.active) return null;
  return "AI help is on the house, from your admin";
}
