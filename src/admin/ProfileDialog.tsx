import { useId, useLayoutEffect, useRef } from "react";
import type { AdminProfile } from "../../shared/types.ts";
import { ProfileForm } from "./ProfileForm.tsx";
import type { ProfileInput } from "./ProfileForm.tsx";

type Props = {
  /** The profile being edited; null while a new one is added. */
  profile: AdminProfile | null;
  saving: boolean;
  onSave: (input: ProfileInput) => Promise<void>;
  onClose: () => void;
};

/**
 * The profile form in a modal dialog over the list, so the rows behind it stay where they are. Like the book dialog, the
 * browser's own Escape is stopped while a save is running, and any close the browser makes by itself goes back through
 * `onClose`, so the page never believes a dialog is open that is not.
 */
export function ProfileDialog({ profile, saving, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useLayoutEffect(() => {
    const box = dialog.current;
    box?.showModal();
    return () => {
      if (box?.open) box.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="shelf-dialog"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onClose={onClose}
    >
      <h2 id={headingId}>{profile ? "Edit profile" : "Add a profile"}</h2>
      <ProfileForm profile={profile} saving={saving} onSave={onSave} onClose={onClose} />
    </dialog>
  );
}
