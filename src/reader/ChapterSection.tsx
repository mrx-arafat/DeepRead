import { memo, useMemo } from "react";
import type { BookDetail, Chapter, LangCode } from "../../shared/types.ts";
import { kindOf, minutes, readableBlocks } from "./book.ts";
import { ChapterAid } from "./ChapterAid.tsx";
import { ChapterText, type TextActions } from "./ChapterText.tsx";
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
  const text = book.chapters.filter((item) => kindOf(item) === "body");
  const index = text.findIndex((item) => item.id === chapter.id);
  const summary = text[index];
  const kind = kindOf(book.chapters.find((item) => item.id === chapter.id) ?? chapter);
  const titleId = `chapter-title-${chapter.id}`;

  return (
    <article className="chapter" data-chapter={chapter.id} aria-labelledby={titleId}>
      <header className="chapter-head">
        <p className="chapter-meta">
          {kind === "front"
            ? "Before the main text"
            : kind === "back"
              ? "After the main text"
              : `Chapter ${index + 1} of ${text.length}${summary ? ` · about ${minutes(summary.wordCount)} min` : ""}`}
        </p>
        <h1 id={titleId}>{chapter.title}</h1>
      </header>

      {/* A title page or a licence needs no preview or summary. */}
      {kind === "body" && <ChapterAid kind="preview" bookId={book.id} chapterId={chapter.id} lang={lang} />}
      <ChapterText blocks={blocks} notes={notes} bookId={book.id} chapterId={chapter.id} lang={lang} actions={actions} />
      {kind === "body" && <ChapterAid kind="recap" bookId={book.id} chapterId={chapter.id} lang={lang} />}
    </article>
  );
});
