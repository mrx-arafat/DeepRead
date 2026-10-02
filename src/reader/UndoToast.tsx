import { useEffect, useRef, useState } from "react";

type Props = {
  /** What was just done, e.g. "Note removed". */
  message: string;
  /** Put focus on Undo: the reader's focus was on a button that is now gone. */
  autoFocus: boolean;
  onUndo: () => void;
  /** The time to undo is over. */
  onTimeout: () => void;
};

// Long enough to notice it and reach Undo. It waits while the pointer or the focus is on it, so it never goes mid-reach.
const SHOWN_MS = 8000;

/** A short "done, Undo" line at the foot of the window. Put it in a status region so screen readers hear it. */
export function UndoToast({ message, autoFocus, onUndo, onTimeout }: Props) {
  const undo = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (autoFocus) undo.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(onTimeout, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [hovered, focused, onTimeout]);

  return (
    <div
      className="toast"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <span>{message}</span>
      <button ref={undo} type="button" className="toast-undo" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
