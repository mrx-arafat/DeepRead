import { Eye, LogOut, Pencil, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { formatBytes } from "../../shared/bytes.ts";
import { AI_PROVIDERS } from "../../shared/types.ts";
import type { AdminProfile } from "../../shared/types.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { addedText, bookCountText, deleteQuestion } from "./profileText.ts";

type Props = {
  profile: AdminProfile;
  mode: "view" | "delete";
  /** Whether any request is running. Every row waits for it, so only one request runs at a time. */
  busy: boolean;
  /** Whether it is this profile's removal that is running. */
  removing: boolean;
  /** Whether it is this profile's sign-out everywhere that is running. */
  signingOut: boolean;
  deleteError: string | null;
  signOutError: string | null;
  onRead: () => void;
  onEdit: () => void;
  onAi: () => void;
  onSignOut: () => void;
  onAskDelete: () => void;
  onKeep: () => void;
  onDelete: () => void;
};

/** One profile in the list: who it is, how much it holds, and what the admin can do with it. */
export function ProfileRow({
  profile,
  mode,
  busy,
  removing,
  signingOut,
  deleteError,
  signOutError,
  onRead,
  onEdit,
  onAi,
  onSignOut,
  onAskDelete,
  onKeep,
  onDelete,
}: Props) {
  const questionId = useId();
  const deleteButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  // Set only when the admin backs out of the question, so focus returns to the Delete button that asked it and is
  // never pulled back when another row takes over.
  const returnFocus = useRef(false);

  useEffect(() => {
    if (mode === "delete") {
      // The safe choice gets focus; it is also where focus lands again if the removal fails.
      keepButton.current?.focus();
    } else if (returnFocus.current) {
      deleteButton.current?.focus();
      returnFocus.current = false;
    }
  }, [mode, deleteError]);

  function keep() {
    returnFocus.current = true;
    onKeep();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLLIElement>) {
    // Like the edit form: Escape backs out of the question, and does nothing while the removal is in flight.
    if (event.key === "Escape" && mode === "delete" && !removing) keep();
  }

  const added = addedText(profile.createdAt);
  return (
    <li className="admin-row" onKeyDown={handleKeyDown}>
      <Avatar profile={profile} size={48} />
      <div className="admin-who">
        <h2 className="admin-name">
          {profile.name}
          {profile.badge && <span className="admin-mark">{profile.badge}</span>}
          {profile.aiRequested.length > 0 && (
            <span className="admin-ask">Asked for {profile.aiRequested.map((id) => AI_PROVIDERS[id]).join(", ")}</span>
          )}
        </h2>
        <p className="admin-meta">
          {bookCountText(profile.bookCount)}, {formatBytes(profile.used)}
          {added && `, added ${added}`}
          {!profile.admin && `. AI: ${profile.ai.length > 0 ? profile.ai.map((id) => AI_PROVIDERS[id]).join(", ") : "none yet"}`}
        </p>
      </div>
      {mode === "view" && (
        <div className="admin-actions">
          <div className="admin-actions-group">
            {!profile.admin && (
              <button type="button" className="quiet-button" disabled={busy} onClick={onRead}>
                <Eye size={16} aria-hidden /> Read as {profile.name}
              </button>
            )}
            <button type="button" className="quiet-button" aria-label={`Edit ${profile.name}`} disabled={busy} onClick={onEdit}>
              <Pencil size={16} aria-hidden /> Edit
            </button>
            {!profile.admin && (
              <button type="button" className="quiet-button" aria-label={`AI helpers for ${profile.name}`} disabled={busy} onClick={onAi}>
                <Sparkles size={16} aria-hidden /> AI helpers
              </button>
            )}
          </div>
          {!profile.admin && (
            // The two that end something, kept together and apart from the rest, so they wrap as a pair and never one alone.
            <div className="admin-actions-group">
              {/* Not disabled while its own request runs, or keyboard focus would fall off the button that was pressed. */}
              <button
                type="button"
                className="quiet-button"
                aria-label={`Sign out everywhere for ${profile.name}`}
                disabled={busy && !signingOut}
                aria-disabled={signingOut || undefined}
                onClick={signingOut ? undefined : onSignOut}
              >
                <LogOut size={16} aria-hidden /> {signingOut ? "Signing out..." : "Sign out everywhere"}
              </button>
              <button
                ref={deleteButton}
                type="button"
                className="quiet-button admin-delete"
                aria-label={`Delete ${profile.name}`}
                disabled={busy}
                onClick={onAskDelete}
              >
                <Trash2 size={16} aria-hidden /> Delete
              </button>
            </div>
          )}
        </div>
      )}
      {mode === "delete" && (
        <div className="shelf-confirm admin-confirm" role="group" aria-labelledby={questionId}>
          <p id={questionId}>{deleteQuestion(profile.name, profile.bookCount)}</p>
          <div className="shelf-confirm-actions">
            <button type="button" className="link-button danger" disabled={busy} onClick={onDelete}>
              {removing ? "Deleting..." : "Delete"}
            </button>
            <button ref={keepButton} type="button" className="link-button" disabled={busy} onClick={keep}>
              Keep
            </button>
          </div>
        </div>
      )}
      {(deleteError ?? signOutError) && (
        <p className="inline-error admin-row-error" role="alert">
          {deleteError ?? signOutError}
        </p>
      )}
    </li>
  );
}
