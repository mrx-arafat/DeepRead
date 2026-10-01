import { X } from "lucide-react";
import { useLayoutEffect, useRef, type MouseEvent } from "react";
import { Link } from "wouter";
import type { BookDetail } from "../../shared/types.ts";
import { minutes } from "./book.ts";

type Props = {
  book: BookDetail;
  currentId: string | null;
  onClose: () => void;
};

/**
 * The table of contents, as a modal dialog: the page behind is out of reach until it closes, and closing it puts
 * focus back where it was. A chapter already on the page is scrolled to; any other starts the book from there.
 */
export function ChapterList({ book, currentId, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLOListElement>(null);

  useLayoutEffect(() => {
    const box = dialog.current;
    const rows = list.current;
    if (!box || !rows) return;
    box.showModal();
    // Open with the reader's own chapter in the middle of the list, so a late chapter is not below the fold,
    // and start the keyboard there too.
    const row = rows.querySelector<HTMLElement>('[aria-current="page"]') ?? rows.querySelector<HTMLElement>("a");
    if (row) {
      const rowBox = row.getBoundingClientRect();
      const listBox = rows.getBoundingClientRect();
      rows.scrollTop += rowBox.top - listBox.top - (listBox.height - rowBox.height) / 2;
      row.focus({ preventScroll: true });
    }
    return () => {
      if (box.open) box.close();
    };
  }, []);

  const close = () => dialog.current?.close();

  // A click on the dimmed page around the list reaches the dialog itself, outside its box.
  function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === event.currentTarget && outside) close();
  }

  function pick(event: MouseEvent, chapterId: string) {
    close();
    const section = document.querySelector(`[data-chapter="${CSS.escape(chapterId)}"]`);
    if (!section) return;
    event.preventDefault();
    section.scrollIntoView({ block: "start" });
  }

  return (
    <dialog ref={dialog} className="toc" aria-labelledby="toc-title" onClose={onClose} onClick={closeOnBackdrop}>
      <header className="toc-head">
        <h2 id="toc-title">Chapters</h2>
        <button type="button" className="icon-button" aria-label="Close chapters" onClick={close}>
          <X size={20} aria-hidden />
        </button>
      </header>
      <ol ref={list}>
        {book.chapters.map((item) => (
          <li key={item.id}>
            <Link
              href={`/book/${book.id}/${item.id}`}
              className="toc-link"
              aria-current={item.id === currentId ? "page" : undefined}
              onClick={(event) => pick(event, item.id)}
            >
              <span>{item.title}</span>
              <span className="toc-time">{minutes(item.wordCount)} min</span>
            </Link>
          </li>
        ))}
      </ol>
    </dialog>
  );
}
