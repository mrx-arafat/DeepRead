import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterTranslation } from "../../shared/types.ts";
import { api, ApiFailure } from "../api.ts";
import { useChapterTranslation, type ChapterTranslationState } from "./useChapterTranslation.ts";

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
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const at = state.effect++;
      const before = state.effects[at];
      if (before && deps.every((dep, index) => Object.is(dep, before.deps[index]))) return;
      before?.cleanup?.();
      state.effects[at] = { deps, cleanup: effect() ?? undefined };
    },
  };
});

vi.mock("react", () => ({
  useState: react.useState,
  useEffect: react.useEffect,
  useEffectEvent: (callback: unknown) => callback,
}));
vi.mock("react-dom", () => ({ flushSync: (change: () => void) => change() }));
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

function render(chapterId: string, on: boolean, onRefused = () => {}): ChapterTranslationState {
  react.state.slot = 0;
  react.state.effect = 0;
  return useChapterTranslation("book", chapterId, "bn", on, onRefused);
}

describe("useChapterTranslation", () => {
  beforeEach(() => {
    react.state.slots = [];
    react.state.effects = [];
    fetchTranslation.mockReset();
    // Arrivals hold the reader's place: there is no page here to hold, so nothing to scroll.
    vi.stubGlobal("document", { documentElement: { style: { removeProperty: () => "" } }, querySelectorAll: () => [] });
    vi.stubGlobal("requestAnimationFrame", (frame: () => void) => frame());
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
