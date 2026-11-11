import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get() }));

/** A stand-in for the voice's worker: it keeps what it is asked and answers when the test says so. */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  readonly asked: Array<{ type: string; id?: number }> = [];
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(message: { type: string; id?: number }) {
    this.asked.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  answer(data: unknown) {
    this.onmessage?.({ data });
  }
}

const KEY = "deepread.naturalVoice";
let stored: Map<string, string>;
/** The locks other pages of DeepRead hold now: a page loading the voice holds one under the voice's name. */
let heldElsewhere: string[];

/** A page: the same storage as the visit before, and nothing else kept. */
async function openPage() {
  vi.resetModules();
  return import("./natural.ts");
}

beforeEach(() => {
  FakeWorker.made = [];
  stored = new Map();
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  heldElsewhere = [];
  vi.stubGlobal("navigator", {
    locks: {
      query: async () => ({ held: heldElsewhere.map((name) => ({ name })) }),
      request: (_name: string, _options: unknown, hold: () => Promise<void>) => hold(),
    },
  });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the natural voice", () => {
  it("should stay off a device that was too slow for it, on this visit and the next", async () => {
    const first = await openPage();
    const loading = first.enableNatural();
    await vi.waitFor(() => expect(FakeWorker.made[0]?.asked).toEqual([{ type: "load" }]));
    FakeWorker.made[0]?.answer({ type: "slow" });
    await loading;
    // The voice's memory goes with its worker.
    expect(FakeWorker.made[0]?.terminated).toBe(true);
    await first.enableNatural();

    const next = await openPage();
    await next.enableNatural();
    expect(FakeWorker.made).toHaveLength(1);
    expect(next.useNaturalState().status).toBe("slow");
    expect(next.naturalReady()).toBe(false);
  });

  it("should not load again after loading it stopped the page", async () => {
    stored.set(KEY, "loading");
    const page = await openPage();
    await page.enableNatural();
    expect(FakeWorker.made).toHaveLength(0);
    expect(page.useNaturalState().status).toBe("crashed");
    expect(stored.get(KEY)).toBe("crashed");
  });

  it("should not take the voice loading in another tab for a page that stopped", async () => {
    stored.set(KEY, "loading");
    heldElsewhere = [KEY];
    const page = await openPage();
    void page.enableNatural();
    await vi.waitFor(() => expect(FakeWorker.made).toHaveLength(1));
    expect(page.useNaturalState().status).toBe("downloading");
  });

  it("should not load again by itself after a load failed, so a sentence read aloud does not restart it", async () => {
    const page = await openPage();
    const loading = page.enableNatural();
    await vi.waitFor(() => expect(FakeWorker.made).toHaveLength(1));
    FakeWorker.made[0]?.answer({ type: "failed", message: "Failed to fetch" });
    await loading;
    await page.enableNatural();
    expect(FakeWorker.made).toHaveLength(1);
    expect(page.useNaturalState()).toMatchObject({ status: "failed", message: "Failed to fetch" });
    // Nothing is remembered: the next visit tries again.
    expect(stored.has(KEY)).toBe(false);
  });

  it("should free the voice and try afresh when the reader goes back to the device voice and chooses it again", async () => {
    const page = await openPage();
    const loading = page.enableNatural();
    await vi.waitFor(() => expect(FakeWorker.made).toHaveLength(1));
    FakeWorker.made[0]?.answer({ type: "slow" });
    await loading;

    page.disableNatural();
    expect(page.useNaturalState().status).toBe("off");
    void page.enableNatural();
    await vi.waitFor(() => expect(FakeWorker.made).toHaveLength(2));
    FakeWorker.made[1]?.answer({ type: "ready" });
    expect(page.naturalReady()).toBe(true);

    page.disableNatural();
    expect(FakeWorker.made[1]?.terminated).toBe(true);
    expect(page.naturalReady()).toBe(false);
  });

  it("should make a sentence's audio in the worker", async () => {
    const page = await openPage();
    void page.enableNatural();
    await vi.waitFor(() => expect(FakeWorker.made).toHaveLength(1));
    const worker = FakeWorker.made[0];
    worker?.answer({ type: "ready" });

    const clip = page.synthesize("Call me Ishmael.", 1.25);
    const request = worker?.asked.at(-1);
    expect(request).toEqual({ type: "clip", id: request?.id, text: "Call me Ishmael.", speed: 1.25 });
    worker?.answer({ type: "clip", id: request?.id, audio: new Float32Array(12000), sampleRate: 24000 });
    expect(await clip).toMatchObject({ sampleRate: 24000, seconds: 0.5 });
  });
});
