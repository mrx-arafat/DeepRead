import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, RefObject } from "react";

type Props = {
  title: string;
  disabled: boolean;
  /** The "more" button, so the row can hand focus back to it when an edit or a removal question closes. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
  onRemove: () => void;
};

/** Place the panel on the side with room for both actions when it cannot fit below the trigger. */
export function menuOpensAbove(triggerTop: number, triggerBottom: number, panelHeight: number, viewportHeight: number): boolean {
  const roomBelow = viewportHeight - triggerBottom;
  return roomBelow < panelHeight + 8 && triggerTop > roomBelow;
}

/**
 * What can be done to a book besides reading it. A disclosure, not a menu role: the two buttons follow the "more"
 * button in tab order, and Escape, a click elsewhere or tabbing away folds them back in. The panel is laid over the shelf by the
 * stylesheet, across the width of the book it belongs to.
 */
export function BookMenu({ title, disabled, triggerRef, onEdit, onRemove }: Props) {
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const height = panel.current?.offsetHeight;
      if (trigger && height) setAbove(menuOpensAbove(trigger.top, trigger.bottom, height, window.innerHeight));
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open) return;
    // The row's own Escape handling (closing a question) must not also run.
    event.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    // Safari does not focus a button when it is pressed, so a null target is a press inside the panel, not Tab leaving.
    if (event.relatedTarget && !root.current?.contains(event.relatedTarget)) setOpen(false);
  }

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="shelf-menu" ref={root} onKeyDown={handleKeyDown} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label={`More actions for ${title}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        <Ellipsis size={20} aria-hidden />
      </button>
      {open && (
        <div className="shelf-menu-panel" id={panelId} ref={panel} data-above={above || undefined}>
          <button type="button" aria-label={`Edit ${title}`} onClick={() => choose(onEdit)}>
            <Pencil size={18} aria-hidden /> Edit
          </button>
          <button type="button" className="danger" aria-label={`Remove ${title}`} onClick={() => choose(onRemove)}>
            <Trash2 size={18} aria-hidden /> Remove
          </button>
        </div>
      )}
    </div>
  );
}
