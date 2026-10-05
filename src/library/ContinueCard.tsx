import { ArrowRight, Bookmark } from "lucide-react";
import { useId } from "react";
import { Link } from "wouter";
import { readingNote } from "./bookText.ts";
import type { StartedBook } from "./bookText.ts";
import { Cover } from "./Cover.tsx";

/** The book read last, with a way straight back in. The whole card is the link: the button's own box is stretched over it. */
export function ContinueCard({ book }: { book: StartedBook }) {
  const headingId = useId();
  const note = readingNote(book);
  return (
    <section aria-labelledby={headingId}>
      <h2 className="library-section" id={headingId}>
        Continue reading
      </h2>
      <div className="continue-card">
        <div className="continue-cover" aria-hidden>
          <Cover book={book} />
        </div>
        <div className="continue-body">
          <h3 className="continue-title">{book.title}</h3>
          {book.author && <p className="continue-author">{book.author}</p>}
          <p className="continue-chapter">
            <Bookmark size={16} aria-hidden />
            <span>
              <span className="visually-hidden">Stopped in </span>
              {book.progress.chapterTitle}
            </span>
          </p>
          <div className="continue-progress">
            <span className="read-bar" aria-hidden>
              <span style={{ width: `${note.percent}%` }} />
            </span>
            <span className="continue-percent">{note.lead}</span>
          </div>
          <p className="continue-left">About {note.detail}</p>
        </div>
        {/* The tooltip carries the whole title, which the card cuts after a few lines. It sits on the link because the
            link's box covers the whole card, heading included. */}
        <Link href={`/book/${book.id}`} className="button continue-action" title={book.title}>
          Continue
          <span className="visually-hidden"> reading {book.title}</span>
          <ArrowRight size={18} aria-hidden />
        </Link>
      </div>
    </section>
  );
}
