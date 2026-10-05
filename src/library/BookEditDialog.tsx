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
 * The edit form in a modal dialog over the shelf, so correcting a title never moves the books around it. The form
 * decides when to close (Escape, Cancel, a saved change): the browser's own Escape is stopped, or it would close the
 * dialog under a save that is still running.
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
    <dialog ref={dialog} className="shelf-dialog" aria-labelledby={headingId} onCancel={(event) => event.preventDefault()}>
      <h2 id={headingId}>Edit book</h2>
      <BookEditForm book={book} saving={saving} onSave={onSave} onClose={onClose} />
    </dialog>
  );
}
