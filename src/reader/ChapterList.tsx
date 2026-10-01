import { X } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "wouter";
import type { BookDetail } from "../../shared/types.ts";
import { minutes } from "./book.ts";

type Props = {
  book: BookDetail;
  currentId: string | null;
  onClose: () => void;
};

/** The table of contents. A chapter already on the page is scrolled to; any other starts the book from there. */
export function ChapterList({ book, currentId, onClose }: Props) {
  function pick(event: MouseEvent, chapterId: string) {
    onClose();
    const section = document.querySelector(`[data-chapter="${CSS.escape(chapterId)}"]`);
    if (!section) return;
    event.preventDefault();
    section.scrollIntoView({ block: "start" });
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <nav className="toc" aria-label="Chapters">
        <header className="toc-head">
          <h2>Chapters</h2>
          <button type="button" className="icon-button" aria-label="Close chapters" onClick={onClose}>
            <X size={20} aria-hidden />
          </button>
        </header>
        <ol>
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
      </nav>
    </>
  );
}
