import type { AiProviderId, AiStatus } from "../../shared/types.ts";

/** How a helper reads after a person's name: "Arafat's Claude Code", "Arafat's API model". */
const IN_A_SENTENCE: Record<AiProviderId, string> = { claude: "Claude Code", codex: "Codex", openrouter: "API model" };

/**
 * Whose AI is answering, for a reader the admin has given one: "Arafat's Claude Code". Null for the admin and for a library
 * without profiles, who are not being given anything, and while nothing answers.
 */
export function helperCredit(status: AiStatus | null, isReader: boolean): string | null {
  if (!isReader || !status?.owner || !status.active) return null;
  return `${status.owner}'s ${IN_A_SENTENCE[status.active]}`;
}
