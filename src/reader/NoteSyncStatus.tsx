import { Check, CloudOff, LoaderCircle, RotateCw, Trash2, TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import type { NoteSyncState } from "./noteSync.ts";

interface NoteSyncStatusProps {
  state: NoteSyncState;
  onRetry: () => void;
  onDiscard: () => void;
}

/** Shows where changes are safe and offers recovery when DeepRead has not saved them. */
export function NoteSyncStatus({ state, onRetry, onDiscard }: NoteSyncStatusProps): ReactElement {
  const { phase, pending, durable, reason } = state;
  const Icon = phase === "saved" ? Check : phase === "saving" ? LoaderCircle : phase === "offline" ? CloudOff : TriangleAlert;
  const label = phase === "saved" ? "Notes saved" : phase === "saving" ? "Notes saving" : phase === "rejected" ? "Some note changes could not be saved" :
    phase === "storage-unavailable" ? "Note recovery is unavailable" : reason === "sign-in" ? "Sign in again to save notes" : "Waiting for connection";
  const recovery = pending > 0 && phase !== "saving" && phase !== "saved";

  return (
    <div className={`note-sync note-sync--${phase}`} role="status" aria-live="polite" aria-atomic="true" aria-label={label} title={label}>
      <span className="note-sync__summary"><Icon size={14} aria-hidden="true" /><span className="note-sync__label">{label}</span></span>
      {recovery && <span className="note-sync__detail">{durable ? "Kept in this browser until DeepRead can save. Other devices do not have these changes yet." : "Keep this page open. Closing it may lose unsaved changes."}</span>}
      {phase === "storage-unavailable" && pending === 0 && <span className="note-sync__detail">This browser could not read or store recovery data. Previously held changes have been left untouched.</span>}
      {(recovery || phase === "storage-unavailable" || phase === "offline") && <button type="button" className="note-sync__retry" onClick={onRetry} title="Retry saving changes"><RotateCw size={14} aria-hidden="true" />Retry save</button>}
      {phase === "rejected" && <button type="button" className="note-sync__discard" onClick={onDiscard} title="Discard only the changes DeepRead refused"><Trash2 size={14} aria-hidden="true" />Discard refused changes</button>}
    </div>
  );
}
