import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { BookSummary, PublicProfile } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { shortTitle } from "./bookText.ts";

type Props = {
  book: Pick<BookSummary, "id" | "title">;
  /** The reader, who is not offered as someone to share with. */
  readerId: string;
  onClose: () => void;
  /** After each change, with the ids of everyone the book is now shared with. */
  onChange?: (sharedWith: string[]) => void;
};

/**
 * Who may read one of the reader's books: everyone else who reads here, each with a switch that shares the book with
 * them or stops sharing it, at once. A modal dialog, closed like the book's edit dialog.
 */
export function ShareDialog({ book, readerId, onClose, onChange }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const introId = useId();
  const [people, setPeople] = useState<PublicProfile[] | null>(null);
  const [shared, setShared] = useState<ReadonlySet<string>>(new Set());
  const [changing, setChanging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const box = dialog.current;
    box?.showModal();
    return () => {
      if (box?.open) box.close();
    };
  }, []);

  useEffect(() => {
    let current = true;
    Promise.all([api.profiles(), api.bookShares(book.id)])
      .then(([everyone, shares]) => {
        if (!current) return;
        setPeople(everyone.filter((person) => person.id !== readerId));
        setShared(new Set(shares.map((share) => share.profile.id)));
      })
      .catch((err: unknown) => current && setError(err instanceof Error ? err.message : "Could not find who reads here."));
    return () => {
      current = false;
    };
  }, [book.id, readerId]);

  async function toggle(person: PublicProfile) {
    const sharing = !shared.has(person.id);
    setChanging(person.id);
    setError(null);
    try {
      if (sharing) await api.shareBook(book.id, person.id);
      else await api.unshareBook(book.id, person.id);
      const next = new Set(shared);
      if (sharing) next.add(person.id);
      else next.delete(person.id);
      setShared(next);
      onChange?.([...next]);
    } catch (err) {
      const fallback = sharing ? `Could not share it with ${person.name}. Please try again.` : `Could not stop sharing it with ${person.name}. Please try again.`;
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setChanging(null);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="shelf-dialog share-dialog"
      aria-labelledby={headingId}
      aria-describedby={introId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <h2 id={headingId}>Share &ldquo;{shortTitle(book.title, 40)}&rdquo;</h2>
      <p id={introId} className="share-intro">
        Sharing is caring. They find it on their shelf and read it with their own notes and place, but cannot change it.
        Stop sharing whenever you like.
      </p>

      {people === null && !error && <p className="share-quiet">Finding who reads here...</p>}
      {people?.length === 0 && <p className="share-quiet">Nobody else reads here yet. The admin can add a profile for them.</p>}
      {people && people.length > 0 && (
        <ul className="share-people">
          {people.map((person) => {
            const on = shared.has(person.id);
            return (
              <li key={person.id} className="share-person">
                <Avatar profile={person} size={40} />
                <span className="share-who">
                  <span className="share-name">{person.name}</span>
                  <span className="share-state">{on ? "Can read it" : "Not shared"}</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={on}
                  aria-label={`Share with ${person.name}`}
                  disabled={changing !== null}
                  onClick={() => void toggle(person)}
                >
                  <span className="switch-track" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="shelf-edit-actions">
        <button type="button" className="button" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}
