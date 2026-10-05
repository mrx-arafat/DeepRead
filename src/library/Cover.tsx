import { useState } from "react";
import type { BookSummary } from "../../shared/types.ts";
import { clothFor, coverTitleSize } from "./bookText.ts";

type Picture = "loading" | "shown" | "failed";

/**
 * A book's cover: its own, from page 1 of its PDF, when it has one. Otherwise one made from its title and author:
 * cloth-bound, the title stamped in cream, a hinge down the left. The made one is always underneath the picture, so a
 * screen reader still reads the title, and it is what the reader sees if the picture cannot be loaded.
 */
export function Cover({ book }: { book: Pick<BookSummary, "id" | "title" | "author" | "hasCover"> }) {
  // Kept with the book it is about: the Continue card shows another book in the same place once the first is removed.
  const [picture, setPicture] = useState<{ of: string; is: Picture }>({ of: book.id, is: "loading" });
  const state = picture.of === book.id ? picture.is : "loading";
  const showPicture = book.hasCover && state !== "failed";
  return (
    <span
      className="cover"
      data-cloth={clothFor(book.title)}
      data-size={coverTitleSize(book.title)}
      data-picture={showPicture ? state : undefined}
    >
      <span className="cover-face">
        <span className="cover-title">{book.title}</span>
        {book.author && <span className="cover-author">{book.author}</span>}
      </span>
      {showPicture && (
        <img
          className="cover-picture"
          src={`/api/books/${book.id}/cover`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          // A picture the browser already holds is shown at once, without fading in again on every visit.
          ref={(img) => {
            if (state === "loading" && img?.complete && img.naturalWidth > 0) setPicture({ of: book.id, is: "shown" });
          }}
          onLoad={() => setPicture({ of: book.id, is: "shown" })}
          onError={() => setPicture({ of: book.id, is: "failed" })}
        />
      )}
    </span>
  );
}
