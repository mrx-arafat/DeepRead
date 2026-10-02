import { Pointer, X } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
import { lookupTipDone, subscribeLookupTip } from "./lookupTip.ts";

/**
 * A quiet first-visit hint beside the first paragraph: the way to ask about a word or a passage is invisible
 * until someone shows it. The wording follows the device (a touch screen taps and presses, a mouse clicks and
 * selects) through `(pointer: coarse)`, the same test the rest of the page uses for touch.
 * Once the reader has used a lookup it fades but keeps its place, so a phone's text does not jump up under the
 * finger that just tapped; the next visit does not show it at all.
 */
export function LookupTip({ onDismiss }: { onDismiss: () => void }) {
  const tip = useRef<HTMLDivElement>(null);
  const used = useSyncExternalStore(subscribeLookupTip, lookupTipDone);

  function close(button: HTMLButtonElement) {
    // The button that has keyboard focus is about to leave the page: carry on at the text instead of dropping to the top.
    const text = button.matches(":focus-visible")
      ? tip.current?.closest(".chapter")?.querySelector<HTMLElement>('[data-block][tabindex="0"]')
      : null;
    onDismiss();
    // React ignores focus events while it commits, so the paragraph takes focus once the tip is gone.
    queueMicrotask(() => text?.focus({ preventScroll: true }));
  }

  return (
    <div ref={tip} className="tip" role="note" aria-label="Tip" data-used={used || undefined}>
      <Pointer className="tip-icon" size={18} aria-hidden />
      <p className="tip-text">
        <span className="tip-mouse">
          Click <span className="tip-word">any word</span> for its meaning. Select a passage to get it explained.
        </span>
        <span className="tip-touch">
          Tap <span className="tip-word">any word</span> for its meaning. Press and hold to select a passage and get it explained.
        </span>
      </p>
      <button type="button" className="icon-button" aria-label="Dismiss tip" onClick={(event) => close(event.currentTarget)}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
