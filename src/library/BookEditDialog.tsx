import { useId, useLayoutEffect, useRef } from "react";
import type { BookSummary, BookUpdate } from "../../shared/types.ts";
import { BookEditForm } from "./BookEditForm.tsx";

type Props = {
  book: BookSummary;
  saving: boolean;
  onSave: (update: BookUpdate) => Promise<void>;
  onClose: () => void;
};

/**
 * The edit form in a modal dialog over the shelf, so correcting a title never moves the books around it. The browser's
 * own Escape is stopped while a save is running, which it would otherwise close the dialog under; at any other time it
 * closes the dialog as Cancel does. The browser can still close a dialog by itself (after repeated Escapes), so its
 * close always goes back through `onClose`: otherwise the shelf would think the dialog open and never show it again.
 */
export function BookEditDialog({ book, saving, onSave, onClose }: Props) {
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
      <h2 id={headingId}>Edit book</h2>
      <BookEditForm book={book} saving={saving} onSave={onSave} onClose={onClose} />
    </dialog>
  );
}
