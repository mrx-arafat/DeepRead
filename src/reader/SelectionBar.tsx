import { autoUpdate, flip, inline, offset, shift, useFloating } from "@floating-ui/react";
import { HandHeart, Headphones } from "lucide-react";
import { useLayoutEffect, type KeyboardEvent } from "react";
import { LANGUAGES, type ExplainMode, type LangCode } from "../../shared/types.ts";
import { useHelperCredit } from "./aiStatusStore.ts";
import { HighlightGroup, type HighlightChoice } from "./HighlightGroup.tsx";
import { canSpeak } from "./speech.ts";
import { blockOf } from "./textRanges.ts";

type Props = {
  range: Range;
  lang: LangCode;
  /** Opened from the keyboard: move focus to the first button. */
  autoFocus?: boolean;
  /** Selected by touch: the phone's own Copy menu sits above the text, so the bar goes below, clear of the handle. */
  touch?: boolean;
  onExplain: (mode: ExplainMode) => void;
  onListen: () => void;
  /** Highlighting the selection; absent when its words could not be found in the book's text to paint. */
  highlight?: HighlightChoice;
};

// The end handle hangs about 24px below the last selected line on Android and iOS.
const TOUCH_HANDLE_CLEARANCE = 32;

/** Left and Right move between the buttons, as in any toolbar. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const buttons = [...event.currentTarget.querySelectorAll("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = buttons[(at + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
  next?.focus();
  event.preventDefault();
}

/** The small bar that appears over selected text: how do you want this explained, or highlighted? */
export function SelectionBar({ range, lang, autoFocus, touch, onExplain, onListen, highlight }: Props) {
  // For a reader the admin shared an AI with: whose it is, where they choose to use it. Sharing is caring.
  const credit = useHelperCredit();
  const { refs, floatingStyles } = useFloating({
    placement: touch ? "bottom" : "top",
    middleware: [inline(), offset(touch ? TOUCH_HANDLE_CLEARANCE : 8), flip({ padding: 64, crossAxis: false }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  useLayoutEffect(() => {
    refs.setPositionReference({
      getBoundingClientRect: () => range.getBoundingClientRect(),
      getClientRects: () => range.getClientRects(),
    });
  }, [refs, range]);

  // Closing the bar from inside (Escape, or a choice made) hands focus back to the paragraph.
  useLayoutEffect(() => {
    const bar = refs.floating.current;
    if (autoFocus) bar?.querySelector("button")?.focus({ preventScroll: true });
    return () => {
      if (!bar?.contains(document.activeElement)) return;
      // React ignores focus events while it commits, so the paragraph takes focus once the bar is gone.
      const block = blockOf(range.startContainer);
      queueMicrotask(() => block?.focus({ preventScroll: true }));
    };
  }, [refs, range, autoFocus]);

  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className="popover selection-bar"
      role="toolbar"
      aria-label={highlight ? "Explain or highlight selected text" : "Explain selected text"}
      // Keep the text selected while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={moveFocus}
    >
      <button type="button" onClick={() => onExplain("simple")}>
        Explain
      </button>
      <button type="button" onClick={() => onExplain("example")}>
        Example
      </button>
      <button type="button" onClick={() => onExplain("native")}>
        In {LANGUAGES[lang]}
      </button>
      {canSpeak && (
        <button type="button" aria-label="Listen from here" title="Listen from here" onClick={onListen}>
          <Headphones size={16} aria-hidden /> Listen
        </button>
      )}
      {highlight && <HighlightGroup {...highlight} />}
      {credit && (
        <p className="selection-credit">
          <HandHeart size={13} aria-hidden /> With {credit}, shared with you
        </p>
      )}
    </div>
  );
}
