import { ArrowRight, RotateCcw, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Link } from "wouter";
import type { Chapter, Note } from "../../shared/types.ts";
import { api, ApiFailure } from "../api.ts";
import type { StartedBook } from "./bookText.ts";
import { resumeText } from "./resumeText.ts";

interface Props {
  book: StartedBook;
  onClose: () => void;
}

interface Content {
  chapter: Chapter | null;
  notes: Note[];
  noteError: string | null;
}

/** Read context only while both authorized endpoints still allow access to the book. */
export async function loadResumeContext(book: StartedBook, signal: AbortSignal): Promise<Content> {
  const [chapter, notes] = await Promise.allSettled([
    api.getChapter(book.id, book.progress.chapterId, signal),
    api.getNotes(book.id, signal),
  ]);
  if (notes.status === "rejected") {
    const reason: unknown = notes.reason;
    if (reason instanceof ApiFailure && [401, 403, 404].includes(reason.status)) throw reason;
  }
  if (chapter.status === "rejected") {
    const reason: unknown = chapter.reason;
    if (reason instanceof ApiFailure && reason.status === 404) return { chapter: null, notes: [], noteError: null };
    throw reason;
  }
  return {
    chapter: chapter.value,
    notes: notes.status === "fulfilled" ? notes.value : [],
    noteError: notes.status === "rejected" ? "Your highlights could not be loaded." : null,
  };
}

/** A read-only reminder over the shelf; loading and dismissal never write reading progress. */
export function ResumeContext({ book, onClose }: Props): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    const box = dialog.current;
    box?.showModal();
    return () => {
      if (box?.open) box.close();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError(null);
    void loadResumeContext(book, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setContent(result);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Your place could not be loaded. Please try again.");
      },
    );
    return () => controller.abort();
  }, [book.id, book.progress.chapterId, attempt]);

  const context = useMemo(() => content?.chapter ? resumeText(content.chapter, book.progress, content.notes) : null, [content, book.progress]);
  const missing = content !== null && (!content.chapter || context?.state === "missing");

  return (
    <dialog
      ref={dialog}
      className="shelf-dialog resume-dialog"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="resume-heading">
        <h2 id={headingId}>Where I left off</h2>
        <button type="button" className="icon-button" aria-label="Close reading context" title="Close reading context" onClick={onClose}>
          <X size={20} aria-hidden />
        </button>
      </div>
      <p className="resume-book">{book.title}</p>
      <p className="resume-chapter">{content?.chapter?.title ?? book.progress.chapterTitle}</p>
      {!content && !error && <p className="resume-quiet" role="status">Finding your place...</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {missing && <p className="resume-quiet">The saved passage is no longer available. Open the book to find your place.</p>}
      {context?.state === "start" && <p className="resume-quiet">You are at the beginning of this chapter. There is no preceding passage here yet.</p>}
      {context?.excerpt && (
        <section className="resume-passage" aria-label="Before your saved place">
          <h3>Before your saved place</h3>
          <blockquote>{context.excerpt}</blockquote>
        </section>
      )}
      {context?.highlight && content?.chapter && (
        <section className="resume-highlight" aria-label="Your highlight">
          <h3>Your highlight <span className="resume-source">on page {context.highlight.page}</span></h3>
          <blockquote>{context.highlight.quote}</blockquote>
          <Link
            href={`/book/${book.id}/${content.chapter.id}`}
            state={{
              place: { chapterId: content.chapter.id, blockId: context.highlight.blockId, offset: context.highlight.offset },
              readingDetour: { bookId: book.id, returnTo: { chapterId: book.progress.chapterId, blockId: book.progress.blockId, offset: book.progress.offset ?? 0 } },
            }}
            className="quiet-button resume-view-source"
            onClick={onClose}
          >
            View highlight in book <ArrowRight size={16} aria-hidden />
          </Link>
        </section>
      )}
      {context?.state === "ready" && !context.highlight && !content?.noteError && <p className="resume-quiet">No saved highlight before this place in this chapter.</p>}
      {content?.noteError && <p className="inline-error" role="alert">{content.noteError}</p>}
      <div className="shelf-edit-actions">
        {(error || content?.noteError) && (
          <button type="button" className="quiet-button" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCcw size={16} aria-hidden /> Try again
          </button>
        )}
        {error ? <button type="button" className="button" onClick={onClose}>Back to shelf</button> : <Link href={`/book/${book.id}`} className="button" onClick={onClose}>
          {missing ? "Open book" : "Continue"}<ArrowRight size={18} aria-hidden />
        </Link>}
      </div>
    </dialog>
  );
}
