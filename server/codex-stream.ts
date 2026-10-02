// One line of `codex exec --json` output, read into the same events as Claude's stream (claude-stream.ts).
// Shapes were captured from live runs (see fixtures/); everything we do not need is ignored.
import type { StreamEvent } from "./claude-stream.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UNAUTHORIZED = /\b401\b|unauthorized/i;

function failure(message: string): StreamEvent {
  return { kind: "result", isError: true, text: message, apiStatus: UNAUTHORIZED.test(message) ? 401 : null };
}

/** Returns null for anything that is not answer text or the end of the turn. */
export function parseCodexLine(line: string): StreamEvent | null {
  if (line.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // Codex sends the answer whole, once it is written, not word by word.
  if (parsed.type === "item.completed") {
    const item = parsed.item;
    if (isRecord(item) && item.type === "agent_message" && typeof item.text === "string") {
      return { kind: "text", text: item.text };
    }
    return null;
  }
  if (parsed.type === "turn.completed") return { kind: "result", isError: false, text: "", apiStatus: null };
  if (parsed.type === "turn.failed") {
    const error = parsed.error;
    return failure(isRecord(error) && typeof error.message === "string" ? error.message : "");
  }
  // Codex retries a dropped connection by itself and reports each try; only a refused sign-in is worth stopping for,
  // since it retries that for about twenty seconds before giving up.
  if (parsed.type === "error" && typeof parsed.message === "string" && UNAUTHORIZED.test(parsed.message)) {
    return failure(parsed.message);
  }
  return null;
}
