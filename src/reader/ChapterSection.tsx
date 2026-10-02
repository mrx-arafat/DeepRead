import { memo, useMemo } from "react";
import type { BookDetail, Chapter, LangCode } from "../../shared/types.ts";
import { chapterPosition, kindOf, minutes, readableBlocks } from "./book.ts";
import { ChapterAid } from "./ChapterAid.tsx";
import { ChapterText, type TextActions } from "./ChapterText.tsx";
import { titleId } from "./listenBlocks.ts";
import type { Note } from "./NoteCard.tsx";

type Props = {
  chapter: Chapter;
  book: BookDetail;
  notes: Note[];
  lang: LangCode;
  actions: TextActions;
};

/**
 * One chapter as the book flows past: where it sits, its title, a preview, the text and a recap.
 * Memoized: scrolling and popovers re-render the reader, and a long book must not re-render every chapter with it.
 */
export const ChapterSection = memo(function ChapterSection({ chapter, book, notes, lang, actions }: Props) {
  const blocks = useMemo(() => readableBlocks(chapter), [chapter]);
  const summary = book.chapters.find((item) => item.id === chapter.id);
  const kind = kindOf(summary ?? chapter);
  const position = chapterPosition(book.chapters, chapter.id);
  const headingId = titleId(chapter.id);

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

      {/* A title page or a licence needs no preview or summary. */}
      {kind === "body" && <ChapterAid kind="preview" bookId={book.id} chapterId={chapter.id} lang={lang} />}
      <ChapterText blocks={blocks} notes={notes} bookId={book.id} chapterId={chapter.id} actions={actions} />
      {kind === "body" && <ChapterAid kind="recap" bookId={book.id} chapterId={chapter.id} lang={lang} />}
    </article>
  );
});
