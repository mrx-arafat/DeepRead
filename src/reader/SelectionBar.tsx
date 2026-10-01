import { autoUpdate, flip, inline, offset, shift, useFloating } from "@floating-ui/react";
import { Headphones } from "lucide-react";
import { useLayoutEffect } from "react";
import { LANGUAGES, type ExplainMode, type LangCode } from "../../shared/types.ts";
import { canSpeak } from "./speech.ts";

type Props = {
  range: Range;
  lang: LangCode;
  onExplain: (mode: ExplainMode) => void;
  onListen: () => void;
};

/** The small bar that appears over selected text: how do you want this explained? */
export function SelectionBar({ range, lang, onExplain, onListen }: Props) {
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

  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className="popover selection-bar"
      role="toolbar"
      aria-label="Explain selected text"
      // Keep the text selected while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
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
        <button type="button" aria-label="Listen from here" onClick={onListen}>
          <Headphones size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}
