import { splitTitle } from "./bookText.ts";

/**
 * A book's title set as its main title over its subtitle, each held to its own number of lines (book-title.css), so a
 * title as long as a blurb still fits its place. The whole title stays in the text for a screen reader, and in the
 * tooltip for anyone who wants the part cut off.
 */
export function BookTitle({ title }: { title: string }) {
  const { main, sub } = splitTitle(title);
  return (
    <span className="book-title" title={title}>
      <span className="book-title-main">{main}</span>
      {sub && (
        <>
          <span className="visually-hidden">: </span>
          <span className="book-title-sub">{sub}</span>
        </>
      )}
    </span>
  );
}
