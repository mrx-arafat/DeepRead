import type { BookSummary } from "../../shared/types.ts";
import { clothFor, coverTitleSize } from "./bookText.ts";

/** A book's cover, made from its title and author: cloth-bound, the title stamped in cream, a hinge down the left. */
export function Cover({ book }: { book: Pick<BookSummary, "title" | "author"> }) {
  return (
    <span className="cover" data-cloth={clothFor(book.title)} data-size={coverTitleSize(book.title)}>
      <span className="cover-face">
        <span className="cover-title">{book.title}</span>
        {book.author && <span className="cover-author">{book.author}</span>}
      </span>
    </span>
  );
}
