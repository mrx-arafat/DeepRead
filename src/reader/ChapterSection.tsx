import { memo, useMemo } from "react";
import type { BookDetail, Chapter, HighlightNote, LangCode, QuestionNote } from "../../shared/types.ts";
import { chapterPosition, kindOf, minutes, readableBlocks } from "./book.ts";
import { ChapterAid } from "./ChapterAid.tsx";
import { ChapterClosing } from "./ChapterClosing.tsx";
import { ChapterText, type TextActions } from "./ChapterText.tsx";
import { titleId } from "./listenBlocks.ts";
import { LookupTip } from "./LookupTip.tsx";

type Props = {
  chapter: Chapter;
  book: BookDetail;
  notes: QuestionNote[];
  /** The book's highlights, for the line after the chapter. The same array until one changes, so the memo holds. */
  highlights: HighlightNote[];
  lang: LangCode;
  actions: TextActions;
  /** Shows the how-to-look-things-up tip above the text; closing it calls this. */
  onDismissTip?: () => void;
};

// Below this (about three minutes), a section is read faster than a preview of it, and a box before and after it
// would take more room than its text.
const AID_MIN_WORDS = 500;

/**
 * One chapter as the book flows past: where it sits, its title, a preview, the text, a recap and a closing line.
 * Memoized: scrolling and popovers re-render the reader, and a long book must not re-render every chapter with it.
 */
export const ChapterSection = memo(function ChapterSection({ chapter, book, notes, highlights, lang, actions, onDismissTip }: Props) {
  const blocks = useMemo(() => readableBlocks(chapter), [chapter]);
  const summary = book.chapters.find((item) => item.id === chapter.id);
  const kind = kindOf(summary ?? chapter);
  const position = chapterPosition(book.chapters, chapter.id);
  const headingId = titleId(chapter.id);
  // A title page or a licence needs no preview or summary, and neither does a one-page preface.
  const aids = kind === "body" && (summary?.wordCount ?? 0) >= AID_MIN_WORDS;

  return (
    <article className="chapter" data-chapter={chapter.id} aria-labelledby={headingId}>
      <header className="chapter-head">
        <p className="chapter-meta">
          {kind === "front"
            ? "Before the main text"
            : kind === "back"
              ? "After the main text"
              : position
                ? `Chapter ${position.number} of ${position.count} · about ${minutes(summary?.wordCount ?? 0)} min`
                : `About ${minutes(summary?.wordCount ?? 0)} min`}
        </p>
        <h2 id={headingId}>{chapter.title}</h2>
      </header>

      {aids && <ChapterAid kind="preview" bookId={book.id} chapterId={chapter.id} lang={lang} />}
      {onDismissTip && <LookupTip onDismiss={onDismissTip} />}
      <ChapterText blocks={blocks} notes={notes} bookId={book.id} chapterId={chapter.id} actions={actions} />
      {aids && <ChapterAid kind="recap" bookId={book.id} chapterId={chapter.id} lang={lang} />}
      {aids && (
        <ChapterClosing
          bookId={book.id}
          chapterId={chapter.id}
          chapters={book.chapters}
          blocks={blocks}
          notes={notes}
          highlights={highlights}
          lang={lang}
        />
      )}
    </article>
  );
});
