// One line of `claude -p --output-format stream-json --include-partial-messages` output.
// Shapes were captured from a live run (see fixtures/); everything we do not need is ignored.

export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "result"; isError: boolean; text: string; apiStatus: number | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns null for anything that is not answer text or the final result (thinking, init, usage...). */
export function parseStreamLine(line: string): StreamEvent | null {
  if (line.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (parsed.type === "stream_event") {
    const event = parsed.event;
    if (!isRecord(event) || event.type !== "content_block_delta") return null;
    const delta = event.delta;
    // thinking_delta and signature_delta are deliberately dropped: the reader never sees reasoning.
    if (isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
      return { kind: "text", text: delta.text };
    }
    return null;
  }

  if (parsed.type === "result") {
    return {
      kind: "result",
      isError: parsed.is_error === true,
      text: typeof parsed.result === "string" ? parsed.result : "",
      apiStatus: typeof parsed.api_error_status === "number" ? parsed.api_error_status : null,
    };
  }

  return null;
}
