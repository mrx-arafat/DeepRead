import type { ParseErrorKind } from "../../shared/types.ts";

/** A PDF that cannot become a book, with a reason the reader can act on. */
export class ParseError extends Error {
  readonly kind: ParseErrorKind;

  constructor(kind: ParseErrorKind, message: string) {
    super(message);
    this.name = "ParseError";
    this.kind = kind;
  }
}
