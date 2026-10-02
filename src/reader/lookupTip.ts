const KEY = "deepread.lookupTipDone";

// Read once: the reader asks about words all the time, and each ask only needs to know whether the tip is already gone.
let done = read();
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Storage blocked: the tip shows on every visit, which is better than never.
    return false;
  }
}

/** Whether the reader has already looked a word up, selected a passage, or closed the tip. */
export function lookupTipDone(): boolean {
  return done;
}

/** For `useSyncExternalStore`: the tip itself fades when the reader has used what it teaches. */
export function subscribeLookupTip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The reader knows how looking things up works: the tip is not shown again, on this visit or the next. */
export function markLookupTipDone(): void {
  if (done) return;
  done = true;
  for (const listener of listeners) listener();
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Private mode or full storage: the tip stays gone for this visit only.
  }
}
