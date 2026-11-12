import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get() }));

/** The DeepRead server's answers: whether it reads the voice, and each clip it was asked for. */
const server = vi.hoisted(() => ({
  reads: false,
  failing: false,
  asked: [] as Array<{ bookId: string; text: string; speed: number }>,
}));
vi.mock("../api.ts", () => ({
  api: {
    voice: async () => ({ server: server.reads }),
    voiceClip: async (bookId: string, text: string, speed: number) => {
      server.asked.push({ bookId, text, speed });
      if (server.failing) throw new Error("The natural voice cannot be reached just now.");
      return new ArrayBuffer(8);
    },
  },
}));

/** Decodes any MP3 into half a second of sound at the rate it was asked for. */
class FakeOfflineAudioContext {
  readonly sampleRate: number;
  constructor(_channels: number, _length: number, sampleRate: number) {
    this.sampleRate = sampleRate;
  }
  async decodeAudioData() {
    const samples = new Float32Array(this.sampleRate / 2);
    return { sampleRate: this.sampleRate, length: samples.length, getChannelData: () => samples };
  }
}

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
  server.reads = false;
  server.failing = false;
  server.asked = [];
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
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

  it("should be ready at once, loading nothing on this device, when the DeepRead server reads the voice", async () => {
    server.reads = true;
    const page = await openPage();
    await page.enableNatural();
    expect(page.naturalReady()).toBe(true);
    expect(page.useNaturalState()).toMatchObject({ status: "ready", server: true });
    expect(FakeWorker.made).toHaveLength(0);
    expect(stored.has(KEY)).toBe(false);
  });

  it("should get a sentence of the book from the server, as sound to play", async () => {
    server.reads = true;
    const page = await openPage();
    page.setNaturalBook("heart-of-darkness-fb9585e9");
    await page.enableNatural();

    const clip = await page.synthesize("The Nellie swung to her anchor.", 1.25);
    expect(server.asked).toEqual([{ bookId: "heart-of-darkness-fb9585e9", text: "The Nellie swung to her anchor.", speed: 1.25 }]);
    expect(clip).toMatchObject({ sampleRate: 24000, seconds: 0.5 });
  });

  it("should leave the server voice alone for a minute after a sentence could not be made, then try it again", async () => {
    server.reads = true;
    const page = await openPage();
    page.setNaturalBook("heart-of-darkness-fb9585e9");
    await page.enableNatural();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    server.failing = true;
    await expect(page.synthesize("The sea-reach of the Thames.", 1)).rejects.toThrow();
    expect(page.naturalReady()).toBe(false);
    now.mockReturnValue(1_000_000 + 59_000);
    expect(page.naturalReady()).toBe(false);
    now.mockReturnValue(1_000_000 + 60_000);
    expect(page.naturalReady()).toBe(true);
    now.mockRestore();
  });

  it("should load the voice on this device, as before, when the server does not read it", async () => {
    const page = await openPage();
    const loading = page.enableNatural();
    await vi.waitFor(() => expect(FakeWorker.made).toHaveLength(1));
    expect(page.useNaturalState()).toMatchObject({ status: "downloading", server: false });
    FakeWorker.made[0]?.answer({ type: "ready" });
    await loading;
    expect(server.asked).toEqual([]);
  });
});
