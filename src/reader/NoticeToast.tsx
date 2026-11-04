import { useEffect } from "react";

// Long enough to read it; it asks nothing, so it need not wait for the pointer.
const SHOWN_MS = 6000;

/** A short line at the foot of the window saying what just happened, gone by itself. Put it in a status region so screen readers hear it. */
export function NoticeToast({ message, onTimeout }: { message: string; onTimeout: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onTimeout, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [message, onTimeout]);
  return (
    <div className="toast toast-notice">
      <span>{message}</span>
    </div>
  );
}
