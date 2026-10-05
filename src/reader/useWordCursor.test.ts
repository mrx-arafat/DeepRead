import { afterEach, describe, expect, it, vi } from "vitest";
import { useWordCursor } from "./useWordCursor.ts";

vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("./paging.ts", () => ({ inPages: () => false, showOnPage: vi.fn() }));
vi.mock("./textRanges.ts", () => ({
  setHighlight: vi.fn(),
  stepWord: () => ({ start: 0, end: 4 }),
}));

describe("useWordCursor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("should reveal a keyboard word above the reading footer fade", () => {
    class FakeText {
      data = "word";
    }
    const scrollBy = vi.fn();
    let wordBottom = 675;
    const range = {
      setStart: vi.fn(),
      setEnd: vi.fn(),
      getBoundingClientRect: () => ({ top: wordBottom - 28, bottom: wordBottom }),
    };
    const querySelector = vi.fn().mockReturnValue({ getBoundingClientRect: () => ({ top: 688 }) });
    vi.stubGlobal("Text", FakeText);
    vi.stubGlobal("window", { innerHeight: 720, scrollBy });
    vi.stubGlobal("document", {
      createRange: () => range,
      querySelector,
      documentElement: {},
    });
    vi.stubGlobal("getComputedStyle", (_element: unknown, pseudo?: string) =>
      pseudo === "::before" ? { height: "20px" } : { scrollPaddingTop: "52px" },
    );
    const block = { dataset: { block: "c2-b3" }, firstChild: new FakeText() } as unknown as HTMLElement;
    const cursor = useWordCursor("c2-b3", vi.fn());

    const key = {
      target: block,
      key: "ArrowRight",
      preventDefault: vi.fn(),
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    } as unknown as Parameters<typeof cursor.onKeyDown>[0];
    cursor.onKeyDown(key);

    expect(scrollBy).toHaveBeenCalledWith(0, 31);

    scrollBy.mockClear();
    querySelector.mockReturnValue(null);
    wordBottom = 700;
    cursor.onKeyDown(key);
    expect(scrollBy).toHaveBeenCalledWith(0, 76);
  });
});
