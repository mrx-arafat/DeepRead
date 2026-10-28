import { afterEach, describe, expect, it, vi } from "vitest";
import { useWordCursor } from "./useWordCursor.ts";
import { ensureMounted } from "./mountRegistry.ts";

vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("./paging.ts", () => ({ inPages: () => false, showOnPage: vi.fn() }));
vi.mock("./mountRegistry.ts", () => ({ ensureMounted: vi.fn() }));
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

  it("should mount and focus adjacent blocks in data order in both directions", () => {
    class FakeText { data = "word"; }
    vi.stubGlobal("Text", FakeText);
    const range = { setStart: vi.fn(), setEnd: vi.fn(), getBoundingClientRect: () => ({ top: 100, bottom: 120 }) };
    vi.stubGlobal("document", { createRange: () => range, documentElement: {}, querySelector: () => null });
    vi.stubGlobal("window", { innerHeight: 720 });
    vi.stubGlobal("getComputedStyle", () => ({ scrollPaddingTop: "52px" }));
    const makeBlock = (id: string) => ({ dataset: { block: id }, firstChild: new FakeText(), focus: vi.fn(), matches: () => true });
    const first = makeBlock("first");
    const second = makeBlock("second");
    vi.mocked(ensureMounted).mockImplementation((_chapter, id) => (id === "second" ? second : first) as unknown as HTMLElement);
    const cursor = useWordCursor("first", vi.fn(), { chapterId: "c1", blockIds: ["first", "second"] });
    cursor.onFocus({ target: first } as unknown as Parameters<typeof cursor.onFocus>[0]);
    for (const [target, key, expected] of [[first, "ArrowDown", second], [second, "ArrowUp", first]] as const) {
      cursor.onKeyDown({ target, currentTarget: {}, key, preventDefault: vi.fn() } as unknown as Parameters<typeof cursor.onKeyDown>[0]);
      expect(ensureMounted).toHaveBeenLastCalledWith("c1", expected.dataset.block);
      expect(expected.focus).toHaveBeenCalledOnce();
    }
  });
});
