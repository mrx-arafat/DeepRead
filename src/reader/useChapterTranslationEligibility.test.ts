import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LangCode } from "../../shared/types.ts";
import { useChapterTranslationEligibility } from "./useChapterTranslationEligibility.ts";
import { refreshDeviceTier } from "../deviceTier.ts";

const react = vi.hoisted(() => {
  const element = { id: "chapter" };
  const state = { slots: [] as unknown[], effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>, slot: 0, effect: 0 };
  return {
    state, element,
    useState(initial: unknown) {
      const at = state.slot++;
      if (!(at in state.slots)) state.slots[at] = initial;
      return [state.slots[at], (next: unknown) => { state.slots[at] = next; }];
    },
    useRef() {
      const at = state.slot++;
      if (!(at in state.slots)) state.slots[at] = { current: element };
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
vi.mock("react", () => ({
  useState: react.useState, useRef: react.useRef, useEffect: react.useEffect,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

class Observer {
  static instances: Observer[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  readonly options: IntersectionObserverInit;
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void, options: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    Observer.instances.push(this);
  }
  emit(visible: boolean) { this.callback([{ isIntersecting: visible }]); }
}

function render({ on = true, now = false, book = "book", chapter = "c1", lang = "bn" as LangCode } = {}) {
  react.state.slot = 0;
  react.state.effect = 0;
  return useChapterTranslationEligibility(book, chapter, lang, on, now);
}

describe("chapter translation eligibility", () => {
  beforeEach(() => {
    react.state.slots = [];
    react.state.effects = [];
    Observer.instances = [];
    vi.stubGlobal("IntersectionObserver", Observer);
  });
  afterEach(() => {
    react.state.effects.forEach((effect) => effect.cleanup?.());
    vi.unstubAllGlobals();
  });

  it("keeps offscreen chapters inactive until near the viewport, then stays active after scrolling away", () => {
    expect(render().eligible).toBe(false);
    const observer = Observer.instances[0]!;
    expect(observer.options).toEqual({ rootMargin: "600px 0px 600px 0px" });
    expect(observer.observe).toHaveBeenCalledWith(react.element);
    observer.emit(false);
    expect(render().eligible).toBe(false);
    observer.emit(true);
    expect(render().eligible).toBe(true);
    observer.emit(false);
    expect(render().eligible).toBe(true);
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it("starts the opening chapter immediately and keeps it active when another chapter becomes current", () => {
    expect(render({ now: true }).eligible).toBe(true);
    expect(Observer.instances).toHaveLength(0);
    expect(render({ now: false }).eligible).toBe(true);
  });

  it("clears activation when translation is turned off and ignores queued observer callbacks", () => {
    render();
    const observer = Observer.instances[0]!;
    expect(render({ on: false }).eligible).toBe(false);
    observer.emit(true);
    expect(render({ on: true }).eligible).toBe(false);
    Observer.instances.at(-1)!.emit(true);
    expect(render().eligible).toBe(true);
    expect(render({ on: false }).eligible).toBe(false);
    expect(render({ on: true }).eligible).toBe(false);
  });

  it.each([
    { book: "another-book" },
    { chapter: "c2" },
    { lang: "hi" as LangCode },
  ])("resets activation for a new context: %o", (context) => {
    render();
    Observer.instances[0]!.emit(true);
    expect(render().eligible).toBe(true);
    expect(render(context).eligible).toBe(false);
    expect(render(context).eligible).toBe(false);
    Observer.instances.at(-1)!.emit(true);
    expect(render(context).eligible).toBe(true);
  });

  it("preserves translation support when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render();
    expect(render().eligible).toBe(true);
  });

  it("should use the low-tier approach margin", () => {
    refreshDeviceTier({ override: "on" });
    try {
      render();
      expect(Observer.instances[0]!.options.rootMargin).toBe("100% 0px 100% 0px");
    } finally { refreshDeviceTier({ override: "auto" }); }
  });
});
