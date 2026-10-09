import { ArrowRight, Bookmark, History } from "lucide-react";
import { useId } from "react";
import type { ReactElement } from "react";
import { Link } from "wouter";
import { readingNote } from "./bookText.ts";
import type { StartedBook } from "./bookText.ts";
import { Cover } from "./Cover.tsx";

/** The book read last, with direct resume and an optional reminder of the saved passage. */
export function ContinueCard({ book, compact = false, onContext }: { book: StartedBook; compact?: boolean; onContext: () => void }): ReactElement {
  const headingId = useId();
  const note = readingNote(book);
  const actions = (
    <div className="continue-actions">
      <Link href={`/book/${book.id}`} className="button continue-action" title={book.title}>
        Continue
        <span className="visually-hidden"> reading {book.title}</span>
        <ArrowRight size={18} aria-hidden />
      </Link>
      <button type="button" className="quiet-button continue-context" onClick={onContext}>
        <History size={17} aria-hidden /> Where I left off
      </button>
    </div>
  );
  if (compact) {
    return (
      <section className="continue-single" aria-labelledby={headingId}>
        <h2 className="library-section" id={headingId}>Continue reading</h2>
        <p className="continue-chapter"><Bookmark size={16} aria-hidden /><span>{book.progress.chapterTitle}</span></p>
        {actions}
      </section>
    );
  }
  return (
    <section className="continue-feature" aria-labelledby={headingId}>
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
          <p className="continue-left">{note.percent >= 100 ? note.detail : `About ${note.detail}`}</p>
        </div>
        {actions}
      </div>
    </section>
  );
}
