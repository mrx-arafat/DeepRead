import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for the browser's speech engine: it says what it is told and reports a replaced utterance as interrupted. */
class FakeUtterance {
  voice: unknown = null;
  lang = "";
  rate = 1;
  onboundary: ((event: { name: string; charIndex: number; charLength?: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function installEngine() {
  const queue: FakeUtterance[] = [];
  const engine = {
    queue,
    getVoices: () => [],
    addEventListener: () => {},
    speak: (utterance: FakeUtterance) => void queue.push(utterance),
    // Like Chrome: the utterance being spoken is reported as interrupted, the rest are dropped.
    cancel: () => {
      const current = queue.shift();
      queue.length = 0;
      if (current) queueMicrotask(() => current.onerror?.({ error: "interrupted" }));
    },
  };
  vi.stubGlobal("window", { speechSynthesis: engine });
  vi.stubGlobal("speechSynthesis", engine);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return engine;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("speak", () => {
  let engine: ReturnType<typeof installEngine>;

  beforeEach(() => {
    vi.resetModules();
    engine = installEngine();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should tell the interrupted reader to wait, and say when the voice is free, when a word is spoken over a sentence", async () => {
    const { speak, whenVoiceFree } = await import("./speech.ts");
    const events: string[] = [];
    speak("A whole sentence.", {
      onEnd: () => events.push("ended"),
      onInterrupted: () => events.push("interrupted"),
      onError: () => events.push("error"),
    });

    speak("difficult");
    await settle();
    whenVoiceFree(() => events.push("free"));
    expect(events).toEqual(["interrupted"]);

    engine.queue[0]?.onend?.();
    expect(events).toEqual(["interrupted", "free"]);
  });

  it("should end normally and free the voice when nothing interrupts it", async () => {
    const { speak, whenVoiceFree } = await import("./speech.ts");
    const events: string[] = [];
    speak("A whole sentence.", { onEnd: () => events.push("ended") });

    engine.queue[0]?.onend?.();
    whenVoiceFree(() => events.push("free"));
    expect(events).toEqual(["ended", "free"]);
  });

  it("should stay quiet when the reader stops it themselves", async () => {
    const { speak } = await import("./speech.ts");
    const events: string[] = [];
    const stop = speak("A whole sentence.", {
      onEnd: () => events.push("ended"),
      onInterrupted: () => events.push("interrupted"),
      onError: () => events.push("error"),
    });

    stop();
    await settle();
    expect(events).toEqual([]);
  });

  it("should report an engine failure when nobody interrupted it", async () => {
    const { speak } = await import("./speech.ts");
    const events: string[] = [];
    speak("A whole sentence.", { onError: (message) => events.push(message) });

    engine.queue[0]?.onerror?.({ error: "synthesis-failed" });
    expect(events).toEqual(["Reading aloud stopped unexpectedly. Press play to try again."]);
  });
});
