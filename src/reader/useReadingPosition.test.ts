import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetail, Chapter } from "../../shared/types.ts";
import { api } from "../api.ts";
import { detourIn, keepingLine, placeIn, useReadingPosition } from "./useReadingPosition.ts";

const hooks = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>, states: [] as unknown[], effects: [] as Array<{ dependencies?: unknown[]; effect: () => void | (() => void); cleanup?: () => void; changed: boolean; layout: boolean }>,
  refAt: 0, stateAt: 0, effectAt: 0,
  pages: false,
  navigate: vi.fn(),
}));
vi.mock("react", () => {
  const effect = (callback: () => void | (() => void), dependencies?: unknown[], layout = false) => {
    const index = hooks.effectAt++;
    const previous = hooks.effects[index];
    const changed = !previous || !dependencies || dependencies.some((value, at) => !Object.is(value, previous.dependencies?.[at]));
    hooks.effects[index] = { ...previous, effect: callback, dependencies, changed, layout };
  };
  return {
    useRef: (initial: unknown) => hooks.refs[hooks.refAt++] ?? (hooks.refs[hooks.refAt - 1] = { current: initial }),
    useState: (initial: unknown) => {
      const index = hooks.stateAt++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.states[index], (value: unknown) => { hooks.states[index] = typeof value === "function" ? value(hooks.states[index]) : value; }];
    },
    useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => void | (() => void), dependencies?: unknown[]) => effect(callback, dependencies),
    useLayoutEffect: (callback: () => void | (() => void), dependencies?: unknown[]) => effect(callback, dependencies, true),
  };
});
vi.mock("wouter", () => ({ useLocation: () => ["/book/book/c1", hooks.navigate] }));
vi.mock("wouter/use-browser-location", () => ({ useHistoryState: () => history.state }));
vi.mock("../api.ts", () => ({ api: { saveProgress: vi.fn().mockResolvedValue({}) } }));
vi.mock("./paging.ts", () => ({ inPages: () => hooks.pages, pageFrame: () => ({ top: 50, bottom: 750 }) }));

describe("placeIn", () => {
  it("should read the place kept with a page of history, alongside whatever else is there", () => {
    expect(placeIn({ other: 1, place: { chapterId: "c7", blockId: "c7-b6", offset: 569 } })).toEqual({
      chapterId: "c7",
      blockId: "c7-b6",
      offset: 569,
    });
  });

  it("should ignore a page of history with no place, or one written by something else", () => {
    expect(placeIn(null)).toBeNull();
    expect(placeIn("c7")).toBeNull();
    expect(placeIn({ place: "c7-b6" })).toBeNull();
    expect(placeIn({ place: { chapterId: "c7", blockId: "c7-b6" } })).toBeNull();
    expect(placeIn({ place: { chapterId: "c7", blockId: 6, offset: 0 } })).toBeNull();
    for (const offset of [-1, NaN, Infinity, 0.5]) expect(placeIn({ place: { chapterId: "c7", blockId: "c7-b6", offset } })).toBeNull();
  });
});

const returnTo = { chapterId: "c1", blockId: "return", offset: 80 };
const source = { chapterId: "c1", blockId: "source", offset: 0 };
const detourState = () => ({ place: source, readingDetour: { bookId: "book", returnTo } });

describe("reading detour history", () => {
  it("should validate the return position and keep detours scoped to their book", () => {
    expect(detourIn(detourState(), "book")).toEqual({ bookId: "book", returnTo });
    expect(detourIn(detourState(), "other")).toBeNull();
    expect(detourIn({ readingDetour: { bookId: "book", returnTo: { ...returnTo, offset: Infinity } } }, "book")).toBeNull();
    expect(detourIn({ readingDetour: { bookId: "book", returnTo: { ...returnTo, blockId: "" } } }, "book")).toBeNull();
  });
});

function reader(initialState: unknown = detourState()) {
  let scrollY = 0;
  let columns = 20;
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  class FakeText {
    data = "a".repeat(600);
    length = this.data.length;
    block: FakeBlock;
    constructor(block: FakeBlock) { this.block = block; }
  }
  class FakeBlock {
    dataset: { block: string };
    firstChild = new FakeText(this);
    textContent = this.firstChild.data;
    focus = vi.fn();
    isConnected = true;
    top: number;
    chapterId: string;
    constructor(id: string, top: number, chapterId = "c1") { this.dataset = { block: id }; this.top = top; this.chapterId = chapterId; }
    getBoundingClientRect() { return { top: this.top - scrollY, bottom: this.top + Math.ceil(600 / columns) * 20 - scrollY }; }
    closest(selector: string) { return selector === ".row" ? this : chapters.find((chapter) => chapter.dataset.chapter === this.chapterId); }
    scrollIntoView() { scrollY = this.top - (hooks.pages ? 50 : 96); }
  }
  const sourceBlock = new FakeBlock("source", 1000);
  const returnBlock = new FakeBlock("return", 2000);
  let blocks = [sourceBlock, returnBlock];
  const section = (id: string) => ({ dataset: { chapter: id }, lastElementChild: { getBoundingClientRect: () => ({ bottom: 3000 - scrollY }) }, querySelectorAll: () => blocks.filter((block) => block.chapterId === id), querySelector: () => blocks.find((block) => block.chapterId === id) });
  let chapters = [section("c1")];
  const historyMock = { state: initialState, scrollRestoration: "auto", replaceState: (state: unknown) => { historyMock.state = state; } };
  vi.stubGlobal("history", historyMock);
  vi.stubGlobal("Text", FakeText);
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  vi.stubGlobal("window", {
    get scrollY() { return scrollY; }, innerHeight: 800,
    scrollBy: (left: number | { top: number }, top?: number) => { scrollY += typeof left === "number" ? top ?? 0 : left.top; },
    scrollTo: ({ top }: { top: number }) => { scrollY = top; },
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  });
  let visibilityState = "visible";
  vi.stubGlobal("document", {
    get visibilityState() { return visibilityState; },
    querySelectorAll: () => chapters,
    querySelector: (selector: string) => selector.startsWith("[data-block=") ? blocks.find((block) => selector.includes(`"${block.dataset.block}"`)) ?? null : selector.startsWith("[data-chapter=") ? chapters[0] : null,
    addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    createRange: () => {
      let text: FakeText;
      let offset = 0;
      return { setStart: (node: FakeText, at: number) => { text = node; offset = at; }, setEnd: () => {}, getBoundingClientRect: () => ({ top: text.block.top + Math.floor(offset / columns) * 20 - scrollY, bottom: text.block.top + Math.floor(offset / columns) * 20 + 20 - scrollY }) };
    },
  });
  hooks.navigate.mockImplementation((_url: string, options: { state?: unknown } = {}) => { historyMock.state = options.state ?? null; });
  const chapter: Chapter = { id: "c1", title: "One", startPage: 1, endPage: 1, blocks: [] };
  const book: BookDetail = { id: "book", title: "Book", author: null, pageCount: 2, chapterCount: 2, wordCount: 200, addedAt: "", hasCover: false, readingStatus: "reading", warnings: [], chapters: [{ id: "c1", title: "One", startPage: 1, endPage: 1, wordCount: 100 }, { id: "c2", title: "Two", startPage: 2, endPage: 2, wordCount: 100 }], progress: { ...returnTo, updatedAt: "", chapterTitle: "One", percent: 30 } };
  const render = (start: Chapter | undefined = chapter, chapterId = start?.id ?? "c1") => {
    hooks.refAt = hooks.stateAt = hooks.effectAt = 0;
    const position = useReadingPosition("book", chapterId, book, start);
    for (const effect of [...hooks.effects].sort((a, b) => Number(b.layout) - Number(a.layout))) {
      if (!effect.changed) continue;
      effect.cleanup?.();
      effect.cleanup = effect.effect() || undefined;
      effect.changed = false;
    }
    return position;
  };
  return { render, book, chapter, sourceBlock, returnBlock,
    resize: (width: number) => { columns = width; windowEvents.dispatchEvent(new Event("resize")); },
    scroll: (to: number) => { scrollY = to; windowEvents.dispatchEvent(new Event("scroll")); },
    hide: () => { visibilityState = "hidden"; documentEvents.dispatchEvent(new Event("visibilitychange")); },
    leave: () => windowEvents.dispatchEvent(new Event("pagehide")),
    unmount: () => hooks.effects.forEach((effect) => effect.cleanup?.()),
    missingReturn: () => { blocks = [sourceBlock]; },
    showReturnChapter: () => { blocks = [returnBlock]; chapters = [section("c2")]; },
    clearChapters: () => { blocks = []; chapters = []; },
    currentOffset: () => Math.max(0, Math.floor((scrollY + (hooks.pages ? 52 : 96) - returnBlock.top) / 20) * columns),
  };
}

describe("useReadingPosition detours", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.refs = []; hooks.states = []; hooks.effects = []; hooks.pages = false;
    hooks.navigate.mockReset();
    vi.mocked(api.saveProgress).mockClear();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("should keep the same reading line when switching from Scroll to Pages", () => {
    const page = reader({ place: source });
    page.scroll(2000 + 4 * 20 - 96);
    expect(page.currentOffset()).toBe(80);
    keepingLine(() => { hooks.pages = true; });
    expect(page.currentOffset()).toBe(80);
  });

  it("should suppress debounced, hidden, pagehide, cleanup and reload progress saves during a detour", () => {
    const page = reader();
    expect(page.render().detour).toEqual({ bookId: "book", returnTo });
    page.scroll(1100);
    vi.advanceTimersByTime(2000);
    page.hide(); page.leave(); page.unmount();
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(detourIn(history.state, "book")?.returnTo).toEqual(returnTo);
    hooks.refs = []; hooks.states = []; hooks.effects = [];
    page.render();
    vi.advanceTimersByTime(2000);
    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it.each([false, true])("should return to the logical offset after reflow in Pages=%s before resuming saves", (pages) => {
    hooks.pages = pages;
    const page = reader();
    page.render();
    page.resize(10);
    page.render().returnToPlace();
    page.render();
    vi.advanceTimersByTime(2000);
    expect(page.currentOffset()).toBe(80);
    expect(page.returnBlock.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(placeIn(history.state)).toEqual(returnTo);
    expect(page.render().detour).toBeNull();
    expect(api.saveProgress).not.toHaveBeenCalled();
    page.scroll(window.scrollY + 40);
    vi.advanceTimersByTime(2000);
    expect(api.saveProgress).toHaveBeenLastCalledWith("book", "c1", "return", 100);
  });

  it("should adopt the current source position only when Stay Here is chosen", () => {
    const page = reader();
    page.render();
    page.render().stayHere();
    page.render();
    vi.advanceTimersByTime(2000);
    expect(page.render().detour).toBeNull();
    expect(api.saveProgress).toHaveBeenCalledWith("book", "c1", "source", 0);
  });

  it("should adopt the last rendered text block's end when Stay Here is chosen past the chapter text", () => {
    const page = reader();
    const position = page.render();
    page.scroll(3500);
    position.stayHere();
    expect(page.render().detour).toBeNull();
    expect(api.saveProgress).toHaveBeenCalledWith("book", "c1", "return", 600);
    expect(placeIn(history.state)).toEqual({ chapterId: "c1", blockId: "return", offset: 600 });
  });

  it("should explain how to recover when Stay Here is chosen before any chapter is rendered", () => {
    const page = reader();
    page.clearChapters();
    page.render();
    page.render().stayHere();
    const position = page.render();
    expect(position.detour).not.toBeNull();
    expect(position.detourError).toContain("chapter");
    expect(position.detourError).toContain("Retry");
    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it("should keep saves suspended when the return anchor is missing", () => {
    const page = reader();
    page.missingReturn();
    page.render();
    page.render().returnToPlace();
    const position = page.render();
    vi.advanceTimersByTime(2000);
    page.hide(); page.leave();
    expect(position.detour).not.toBeNull();
    expect(position.detourError).toContain("saved passage");
    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it("should retain ordinary chapter navigation saving without a detour", () => {
    const page = reader({ place: source });
    page.render();
    vi.advanceTimersByTime(2000);
    expect(api.saveProgress).toHaveBeenCalledWith("book", "c1", "source", 0);
  });

  it("should protect an in-place source visit from a normal reading timer and cleanup already waiting", () => {
    const page = reader({ place: returnTo });
    page.render();
    history.replaceState(detourState(), "");
    page.render();
    vi.advanceTimersByTime(2000);
    page.hide(); page.leave();
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(page.render().detour?.returnTo).toEqual(returnTo);
  });

  it("should visit a search result without overwriting the place the reader came from", () => {
    const page = reader({ place: source });
    const position = page.render();
    page.scroll(980);
    expect(position.visitPlace(returnTo)).toBe(true);
    expect(hooks.navigate).toHaveBeenCalledWith("/book/book/c1", expect.objectContaining({
      state: expect.objectContaining({
        place: returnTo,
        readingDetour: { bookId: "book", returnTo: { chapterId: "c1", blockId: "source", offset: 60 } },
      }),
    }));
    expect(page.returnBlock.focus).toHaveBeenCalledWith({ preventScroll: true });
    page.render();
    vi.advanceTimersByTime(2000);
    page.hide(); page.leave(); page.unmount();
    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it("should open a search result in another chapter and retain the original return place across further visits", () => {
    const elsewhere = { chapterId: "c2", blockId: "return", offset: 80 };
    const page = reader({ place: source });
    page.returnBlock.chapterId = "c2";
    page.missingReturn();
    page.render();
    page.scroll(980);
    expect(page.render().visitPlace(elsewhere)).toBe(true);
    expect(detourIn(history.state, "book")?.returnTo).toEqual({ chapterId: "c1", blockId: "source", offset: 60 });
    page.showReturnChapter();
    const secondChapter = { ...page.chapter, id: "c2" };
    page.render(secondChapter, "c2");
    expect(page.currentOffset()).toBe(80);
    expect(page.render(secondChapter, "c2").visitPlace({ ...elsewhere, offset: 120 })).toBe(true);
    expect(detourIn(history.state, "book")?.returnTo).toEqual({ chapterId: "c1", blockId: "source", offset: 60 });
    vi.advanceTimersByTime(2000);
    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it("should leave reading progress untouched when a search result cannot be opened", () => {
    const page = reader({ place: source });
    page.clearChapters();
    page.render();
    expect(page.render().visitPlace(returnTo)).toBe(false);
    expect(page.render().detourError).toContain("passage");
    expect(hooks.navigate).not.toHaveBeenCalled();
    expect(detourIn(history.state, "book")).toBeNull();
    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it.each([false, true])("should wait for a different chapter's return anchor before clearing the detour or saving in Pages=%s", (pages) => {
    hooks.pages = pages;
    const elsewhere = { ...returnTo, chapterId: "c2" };
    const page = reader({ place: source, readingDetour: { bookId: "book", returnTo: elsewhere } });
    page.returnBlock.chapterId = "c2";
    page.resize(30);
    page.missingReturn();
    page.render();
    page.render().returnToPlace();
    const waiting = page.render();
    expect(waiting.returning).toBe(true);
    expect(hooks.navigate).toHaveBeenCalledWith("/book/book/c2", expect.objectContaining({ state: expect.objectContaining({ readingDetour: expect.objectContaining({ returnTo: elsewhere }) }) }));
    page.hide(); page.leave();
    expect(api.saveProgress).not.toHaveBeenCalled();
    page.showReturnChapter();
    const returnedChapter = { ...page.chapter, id: "c2" };
    page.render(returnedChapter, "c2");
    const returned = page.render(returnedChapter, "c2");
    vi.advanceTimersByTime(2000);
    expect(returned.detour).toBeNull();
    expect(placeIn(history.state)).toEqual(elsewhere);
    expect(page.returnBlock.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it("should cancel a pending cross-chapter return back to the source without adopting it", () => {
    const elsewhere = { ...returnTo, chapterId: "c2" };
    const page = reader({ place: source, readingDetour: { bookId: "book", returnTo: elsewhere } });
    page.returnBlock.chapterId = "c2";
    page.missingReturn();
    page.render();
    page.render().returnToPlace();
    expect(page.render().returning).toBe(true);
    page.render().cancelReturn();
    const sourceAgain = page.render();
    expect(sourceAgain.returning).toBe(false);
    expect(sourceAgain.detour?.returnTo).toEqual(elsewhere);
    expect(placeIn(history.state)).toEqual(source);
    vi.advanceTimersByTime(2000);
    page.hide(); page.leave();
    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it("should suspend again on Forward into the source entry and resume normal saving on Back", () => {
    const page = reader();
    page.render();
    vi.advanceTimersByTime(400);
    const sourceState = history.state;
    history.replaceState({ place: returnTo }, "");
    page.render();
    vi.advanceTimersByTime(2000);
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    vi.mocked(api.saveProgress).mockClear();
    history.replaceState(sourceState, "");
    expect(page.render().detour?.returnTo).toEqual(returnTo);
    page.scroll(1100);
    vi.advanceTimersByTime(2000);
    page.hide(); page.leave(); page.unmount();
    expect(api.saveProgress).not.toHaveBeenCalled();
  });
});
