import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterTranslation } from "../../shared/types.ts";
import { api, ApiFailure } from "../api.ts";
import { keepingPlace, queueTranslationCommit, useChapterTranslation, type ChapterTranslationState } from "./useChapterTranslation.ts";

// Just enough of React to render the hook again and again: state kept by call order, and effects run again only when
// their dependencies change, cleaning up the run before, as React does.
const react = vi.hoisted(() => {
  const state = { slots: [] as unknown[], effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>, slot: 0, effect: 0 };
  return {
    state,
    useState(initial: unknown) {
      const at = state.slot++;
      if (!(at in state.slots)) state.slots[at] = initial;
      const set = (next: unknown) => {
        state.slots[at] = typeof next === "function" ? (next as (value: unknown) => unknown)(state.slots[at]) : next;
      };
      return [state.slots[at], set];
    },
    useRef(initial: unknown) {
      const at = state.slot++;
      if (!(at in state.slots)) state.slots[at] = { current: initial };
      return state.slots[at];
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const at = state.effect++;
      const before = state.effects[at];
      if (before && deps.every((dep, index) => Object.is(dep, before.deps[index]))) return;
      before?.cleanup?.();
      state.effects[at] = { deps, cleanup: effect() ?? undefined };
    },
  };
});
const scheduling = vi.hoisted(() => ({
  flushSync: vi.fn((change: () => void) => change()),
  startTransition: vi.fn((change: () => void) => change()),
}));

vi.mock("react", () => ({
  useState: react.useState,
  useRef: react.useRef,
  useEffect: react.useEffect,
  useEffectEvent: (callback: unknown) => callback,
  startTransition: scheduling.startTransition,
}));
vi.mock("react-dom", () => ({ flushSync: scheduling.flushSync }));
vi.mock("./useReadingPosition.ts", () => ({ eyeLine: () => 96 }));
vi.mock("../api.ts", () => {
  class ApiFailure extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return { ApiFailure, api: { chapterTranslation: vi.fn() } };
});

const fetchTranslation = vi.mocked(api.chapterTranslation);
const arrived: ChapterTranslation = { lang: "bn", blocks: { b1: "প্রথম অনুচ্ছেদ।" }, engine: "microsoft" };

function render(chapterId: string, on: boolean, onRefused = () => {}, lang: "bn" | "fr" = "bn", bookId = "book"): ChapterTranslationState {
  react.state.slot = 0;
  react.state.effect = 0;
  return useChapterTranslation(bookId, chapterId, lang, on, onRefused);
}

describe("useChapterTranslation", () => {
  beforeEach(() => {
    react.state.slots = [];
    react.state.effects = [];
    fetchTranslation.mockReset();
    scheduling.flushSync.mockClear();
    scheduling.startTransition.mockClear();
    // Arrivals hold the reader's place: there is no page here to hold, so nothing to scroll.
    vi.stubGlobal("document", { documentElement: { style: { removeProperty: () => "" } }, querySelectorAll: () => [] });
    vi.stubGlobal("requestAnimationFrame", (frame: () => void) => frame());
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should fetch a chapter's translation once and show it again after turning it off and on", async () => {
    fetchTranslation.mockResolvedValue(arrived);
    expect(render("c1", false)).toEqual({ status: "off" });
    expect(fetchTranslation).not.toHaveBeenCalled();

    expect(render("c1", true)).toEqual({ status: "loading" });
    expect(fetchTranslation).toHaveBeenCalledWith("book", "c1", "bn", expect.any(AbortSignal));
    await vi.waitFor(() => expect(render("c1", true)).toEqual({ status: "ready", blocks: arrived.blocks }));

    expect(render("c1", false)).toEqual({ status: "off" });
    expect(render("c1", true)).toEqual({ status: "loading" });
    expect(render("c1", true)).toEqual({ status: "ready", blocks: arrived.blocks });
    expect(fetchTranslation).toHaveBeenCalledTimes(1);
  });

  it("should stop asking when translation is turned off before it arrives", () => {
    fetchTranslation.mockReturnValue(new Promise(() => {}));
    render("c2", true);
    const signal = fetchTranslation.mock.calls[0]![3]!;
    expect(signal.aborted).toBe(false);

    expect(render("c2", false)).toEqual({ status: "off" });
    expect(signal.aborted).toBe(true);
  });

  it("ignores a success that resolves after the request was aborted", async () => {
    let resolve!: (translation: ChapterTranslation) => void;
    fetchTranslation.mockReturnValueOnce(new Promise((ready) => { resolve = ready; })).mockReturnValue(new Promise(() => {}));
    render("c-aborted", true);
    render("c-aborted", false);
    resolve(arrived);
    await Promise.resolve();
    expect(scheduling.flushSync).not.toHaveBeenCalled();
    expect(scheduling.startTransition).not.toHaveBeenCalled();
    expect(render("c-aborted", true)).toEqual({ status: "loading" });
    expect(fetchTranslation).toHaveBeenCalledTimes(2);
  });

  it("should ignore a rejection after unmount aborts the request", async () => {
    let reject!: (error: Error) => void;
    fetchTranslation.mockReturnValueOnce(new Promise((_resolve, failed) => { reject = failed; }));
    render("c-aborted-error", true);
    react.state.effects.forEach((effect) => effect.cleanup?.());
    reject(new DOMException("Aborted", "AbortError"));
    await Promise.resolve();
    expect(scheduling.startTransition).not.toHaveBeenCalled();
    expect(scheduling.flushSync).not.toHaveBeenCalled();
    expect(render("c-aborted-error", true)).toEqual({ status: "loading" });
  });

  it.each(["language", "book"])("ignores a pending arrival after changing %s", async (change) => {
    const frames = new Map<number, () => void>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    fetchTranslation.mockResolvedValueOnce(arrived).mockReturnValue(new Promise(() => {}));
    render(`c-pending-${change}`, true);
    await Promise.resolve();
    expect(frames.size).toBe(1);
    render(`c-pending-${change}`, true, () => {}, change === "language" ? "fr" : "bn", change === "book" ? "different-book" : "book");
    expect(frames.size).toBe(0);
    expect(scheduling.startTransition).not.toHaveBeenCalled();
    expect(scheduling.flushSync).not.toHaveBeenCalled();
  });

  it("keeps a mounted chapter's answer after the shared LRU evicts it", async () => {
    fetchTranslation.mockResolvedValue(arrived);
    render("c-mounted", true);
    await Promise.resolve();
    expect(render("c-mounted", true)).toMatchObject({ status: "ready" });
    const slots = [...react.state.slots];
    const effects = [...react.state.effects];
    for (let index = 0; index < 41; index++) {
      react.state.slots = [];
      react.state.effects = [];
      render(`c-cache-${index}`, true);
      await Promise.resolve();
      render(`c-cache-${index}`, true);
    }
    react.state.slots = slots;
    react.state.effects = effects;
    fetchTranslation.mockClear();
    expect(render("c-mounted", true)).toMatchObject({ status: "ready", blocks: arrived.blocks });
    expect(fetchTranslation).not.toHaveBeenCalled();
    // A fresh mount must fetch that evicted chapter again; the visible mounted answer stayed in local state.
    react.state.slots = [];
    react.state.effects = [];
    expect(render("c-mounted", true)).toEqual({ status: "loading" });
    expect(fetchTranslation).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("keeps an oversized active translation locally without repeatedly fetching it", async () => {
    const large = { ...arrived, blocks: { b1: "x".repeat(2_000_001) } };
    fetchTranslation.mockResolvedValue(large);
    render("c-large", true);
    await Promise.resolve();
    expect(render("c-large", true)).toEqual({ status: "ready", blocks: large.blocks });
    render("c-large", false);
    expect(render("c-large", true)).toEqual({ status: "loading" });
    expect(render("c-large", true)).toEqual({ status: "ready", blocks: large.blocks });
    expect(fetchTranslation).toHaveBeenCalledTimes(1);
  });

  it("should say the admin turned translation off, and hand the switch back, when the server refuses", async () => {
    fetchTranslation.mockRejectedValue(new ApiFailure("translation_off", "Translation is off.", 403));
    const onRefused = vi.fn();
    render("c3", true, onRefused);
    await vi.waitFor(() => expect(onRefused).toHaveBeenCalledTimes(1));

    expect(render("c3", false, onRefused)).toEqual({ status: "refused" });
    // Turned on again (the admin allowed it meanwhile): it asks afresh rather than repeating the refusal.
    expect(render("c3", true, onRefused)).toEqual({ status: "loading" });
    expect(fetchTranslation).toHaveBeenCalledTimes(2);
  });

  it("should offer to try again when the translation services fail", async () => {
    fetchTranslation
      .mockRejectedValueOnce(new ApiFailure("translation_unavailable", "The translation services are not answering.", 502))
      .mockResolvedValueOnce(arrived);
    render("c4", true);
    let failed = render("c4", true);
    await vi.waitFor(() => {
      failed = render("c4", true);
      expect(failed).toMatchObject({ status: "failed", message: "The translation services are not answering." });
    });

    if (failed.status === "failed") failed.retry();
    expect(render("c4", true)).toEqual({ status: "loading" });
    expect(fetchTranslation).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(render("c4", true)).toEqual({ status: "ready", blocks: arrived.blocks }));
  });
});

describe("translation arrival commits", () => {
  afterEach(() => vi.unstubAllGlobals());

  function page(atHeader = false, below = false) {
    let top = 40;
    const frames = new Map<number, () => void>();
    let nextFrame = 0;
    const changedChapter = { getBoundingClientRect: () => ({ top: below ? 1000 : 0, bottom: 1800 }) };
    const spot = {
      getBoundingClientRect: () => ({ top, bottom: top + 100 }), isConnected: true,
      closest: () => changedChapter, matches: () => atHeader,
    };
    const scopeQuery = vi.fn(() => [spot]);
    const section = { dataset: { chapter: "current" }, getBoundingClientRect: () => ({ top: 0, bottom: 800 }), querySelectorAll: scopeQuery };
    const globalQuery = vi.fn(() => [section]);
    const scrollBy = vi.fn();
    vi.stubGlobal("document", {
      documentElement: { style: { removeProperty: vi.fn() } },
      querySelectorAll: globalQuery, querySelector: () => changedChapter,
    });
    vi.stubGlobal("CSS", { escape: (id: string) => id });
    vi.stubGlobal("window", { scrollBy });
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    scheduling.flushSync.mockClear();
    scheduling.startTransition.mockClear();
    return {
      frames, scrollBy, scopeQuery, globalQuery,
      move: (next: number) => { top = next; },
      frame: () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(); },
    };
  }

  async function savedAnswer(chapterId: string) {
    react.state.slots = [];
    react.state.effects = [];
    fetchTranslation.mockReset();
    fetchTranslation.mockResolvedValue(arrived);
    vi.stubGlobal("document", { documentElement: { style: { removeProperty: () => "" } }, querySelectorAll: () => [] });
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(chapterId, true);
    await Promise.resolve();
    expect(render(chapterId, true)).toMatchObject({ status: "ready" });
    fetchTranslation.mockClear();
  }

  it("publishes a cached chapter activated above the reader through a queued anchor correction", async () => {
    await savedAnswer("c-cached-above");
    react.state.effects.forEach((effect) => effect.cleanup?.());
    react.state.slots = [];
    react.state.effects = [];
    const dom = page();
    scheduling.flushSync.mockImplementationOnce((change) => { change(); dom.move(200); });
    expect(render("c-cached-above", true)).toEqual({ status: "loading" });
    expect(dom.frames.size).toBe(1);
    expect(scheduling.flushSync).not.toHaveBeenCalled();
    expect(fetchTranslation).not.toHaveBeenCalled();
    dom.frame();
    expect(render("c-cached-above", true)).toEqual({ status: "ready", blocks: arrived.blocks });
    expect(scheduling.flushSync).toHaveBeenCalledTimes(1);
    expect(dom.scrollBy).toHaveBeenCalledWith({ top: 160, behavior: "instant" });
  });

  it("hides publication while off and republishes a retained answer after toggle with no refetch", async () => {
    await savedAnswer("c-toggle-retained");
    const dom = page();
    expect(render("c-toggle-retained", false)).toEqual({ status: "off" });
    scheduling.flushSync.mockImplementationOnce((change) => { change(); dom.move(120); });
    expect(render("c-toggle-retained", true)).toEqual({ status: "loading" });
    expect(dom.frames.size).toBe(1);
    expect(scheduling.flushSync).not.toHaveBeenCalled();
    dom.frame();
    expect(render("c-toggle-retained", true)).toEqual({ status: "ready", blocks: arrived.blocks });
    expect(scheduling.flushSync).toHaveBeenCalledTimes(1);
    expect(dom.scrollBy).toHaveBeenCalledWith({ top: 80, behavior: "instant" });
    expect(fetchTranslation).not.toHaveBeenCalled();
  });

  it("republishes through the queue when changing away and back to a cached language before its frame runs", async () => {
    await savedAnswer("c-language-cycle");
    expect(render("c-language-cycle", true, () => {}, "fr")).toEqual({ status: "loading" });
    await Promise.resolve();
    expect(render("c-language-cycle", true, () => {}, "fr")).toMatchObject({ status: "ready" });
    expect(render("c-language-cycle", true)).toEqual({ status: "loading" });
    expect(render("c-language-cycle", true)).toMatchObject({ status: "ready" });
    fetchTranslation.mockClear();
    const dom = page();
    expect(render("c-language-cycle", true, () => {}, "fr")).toEqual({ status: "loading" });
    expect(render("c-language-cycle", true)).toEqual({ status: "loading" });
    expect(dom.frames.size).toBe(1);
    expect(fetchTranslation).not.toHaveBeenCalled();
    dom.frame();
    expect(render("c-language-cycle", true)).toEqual({ status: "ready", blocks: arrived.blocks });
    expect(scheduling.flushSync).toHaveBeenCalledTimes(1);
  });

  it("batches multiple arrivals into one synchronous correction and queries rows only inside the anchor chapter", () => {
    const dom = page();
    queueTranslationCommit("current", () => dom.move(100));
    queueTranslationCommit("current", () => dom.move(180));
    expect(dom.frames.size).toBe(1);
    expect(scheduling.flushSync).not.toHaveBeenCalled();
    dom.frame();
    expect(scheduling.flushSync).toHaveBeenCalledTimes(1);
    expect(dom.scrollBy).toHaveBeenCalledWith({ top: 140, behavior: "instant" });
    expect(dom.globalQuery).toHaveBeenCalledWith("main.page > *");
    expect(dom.scopeQuery).toHaveBeenCalledTimes(1);
    expect(dom.scopeQuery.mock.calls[0]).toEqual([":scope > :not(.chapter-text, .translation-status, .tip), :scope > .chapter-text .row"]);
  });

  it.each([[true, false], [false, true]])("yields when the anchor is the chapter header=%s or the changed chapter is below it=%s", (header, below) => {
    const dom = page(header, below);
    const change = vi.fn();
    queueTranslationCommit("current", change);
    dom.frame();
    expect(scheduling.startTransition).toHaveBeenCalledTimes(1);
    expect(scheduling.flushSync).not.toHaveBeenCalled();
    expect(dom.scrollBy).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("keeps manual language/translation switches synchronous, including at the header", () => {
    const dom = page(true);
    keepingPlace(() => dom.move(80));
    expect(scheduling.flushSync).toHaveBeenCalledTimes(1);
    expect(scheduling.startTransition).not.toHaveBeenCalled();
    expect(dom.scrollBy).toHaveBeenCalledWith({ top: 40, behavior: "instant" });
  });

  it("preserves the anchor for a global refusal even if its chapter is below the reader", () => {
    const dom = page(false, true);
    queueTranslationCommit("below", () => dom.move(100), true);
    dom.frame();
    expect(scheduling.flushSync).toHaveBeenCalledTimes(1);
    expect(scheduling.startTransition).not.toHaveBeenCalled();
    expect(dom.scrollBy).toHaveBeenCalledWith({ top: 60, behavior: "instant" });
  });

  it("cancels pending commits without changing the cache or DOM", () => {
    const dom = page();
    const change = vi.fn();
    const cancel = queueTranslationCommit("current", change);
    cancel();
    expect(dom.frames.size).toBe(0);
    expect(change).not.toHaveBeenCalled();
    expect(scheduling.flushSync).not.toHaveBeenCalled();
  });
});
