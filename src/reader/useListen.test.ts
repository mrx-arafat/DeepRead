import { afterEach, describe, expect, it, vi } from "vitest";
import { showOnPage } from "./paging.ts";
import { useListen } from "./useListen.ts";

const hook = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
  states: 0,
}));

vi.mock("react", () => ({
  useMemo: (make: () => unknown) => make(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => hook.effects.push(effect),
  useRef: (current: unknown) => {
    const ref = { current };
    hook.refs.push(ref);
    return ref;
  },
  useState: (initial: unknown) => [hook.states++ === 0 ? { blockId: "b1", start: 0 } : initial, vi.fn()],
}));
vi.mock("./paging.ts", () => ({ inPages: () => true, showOnPage: vi.fn() }));
vi.mock("./textRanges.ts", () => ({
  sentencesOf: () => [{ blockId: "b1", start: 0, end: 11, text: "First line." }],
  sentenceIndex: () => 0,
  rangeInBlock: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 120 }) }),
  setHighlight: vi.fn(),
}));

describe("useListen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("should timestamp only a real voice-driven page turn", () => {
    vi.stubGlobal("window", { innerHeight: 720 });
    vi.spyOn(performance, "now").mockReturnValue(1234);
    const pageTurn = vi.mocked(showOnPage);

    for (const turned of [false, true]) {
      hook.effects = [];
      hook.refs = [];
      hook.states = 0;
      pageTurn.mockReturnValue(turned);
      useListen([], 1, { coming: false, error: null, open: vi.fn() });
      hook.effects[3]?.();

      expect(pageTurn).toHaveBeenCalled();
      expect(hook.refs[1]?.current).toBe(turned ? 1234 : -Infinity);
    }
  });
});
