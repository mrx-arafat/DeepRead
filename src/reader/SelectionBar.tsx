import { autoUpdate, flip, inline, offset, shift, useFloating } from "@floating-ui/react";
import { Headphones } from "lucide-react";
import { useLayoutEffect, type KeyboardEvent } from "react";
import { LANGUAGES, type ExplainMode, type LangCode } from "../../shared/types.ts";
import { canSpeak } from "./speech.ts";
import { blockOf } from "./textRanges.ts";

type Props = {
  range: Range;
  lang: LangCode;
  /** Opened from the keyboard: move focus to the first button. */
  autoFocus?: boolean;
  onExplain: (mode: ExplainMode) => void;
  onListen: () => void;
};

/** Left and Right move between the buttons, as in any toolbar. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const buttons = [...event.currentTarget.querySelectorAll("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = buttons[(at + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
  next?.focus();
  event.preventDefault();
}

/** The small bar that appears over selected text: how do you want this explained? */
export function SelectionBar({ range, lang, autoFocus, onExplain, onListen }: Props) {
  const { refs, floatingStyles } = useFloating({
    placement: "top",
    middleware: [inline(), offset(8), flip({ padding: 64 }), shift({ padding: 12 })],
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
      aria-label="Explain selected text"
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
    </div>
  );
}
