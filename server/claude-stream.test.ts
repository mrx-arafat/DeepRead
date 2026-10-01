// Fed with lines captured from real `claude -p --output-format stream-json --include-partial-messages` runs
// (claude 2.1.286, haiku): a normal answer with a thinking block, a bad model name, and a signed-out CLI.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStreamLine } from "./claude-stream.ts";
import type { StreamEvent } from "./claude-stream.ts";

const fixture = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);

const parseAll = (lines: string[]): StreamEvent[] =>
  lines.map(parseStreamLine).filter((event): event is StreamEvent => event !== null);

describe("parseStreamLine", () => {
  it("should yield only the answer text and the final result when given a full captured run", () => {
    const events = parseAll(fixture("claude-haiku-stream.jsonl"));
    const text = events.flatMap((event) => (event.kind === "text" ? [event.text] : []));

    // The run has a thinking block, init/status/usage lines and 19 text deltas; only the deltas are text.
    expect(text).toHaveLength(19);
    expect(text.join("")).toBe(
      "**Ubiquitous** means something that is everywhere at the same time. It's something you find or see constantly all around you.\n\nFor example, smartphones are ubiquitous today because almost everyone has one.",
    );
    expect(events.at(-1)).toMatchObject({ kind: "result", isError: false });
    expect(events.filter((event) => event.kind === "result")).toHaveLength(1);
  });

  it("should report the CLI's message and API status when the final result is an error", () => {
    const badModel = parseAll(fixture("claude-error-bad-model.jsonl")).at(-1);
    expect(badModel).toEqual({
      kind: "result",
      isError: true,
      text: "There's an issue with the selected model (bogus-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.",
      apiStatus: 404,
    });

    const signedOut = parseAll(fixture("claude-error-not-logged-in.jsonl")).at(-1);
    expect(signedOut).toEqual({
      kind: "result",
      isError: true,
      text: "Not logged in · Please run /login",
      apiStatus: null,
    });
  });

  it("should ignore blank lines, non-JSON output and unrelated JSON", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
    expect(parseStreamLine("Warning: something on stdout")).toBeNull();
    expect(parseStreamLine("[1,2,3]")).toBeNull();
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"message_stop"}}')).toBeNull();
  });
});
