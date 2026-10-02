import { X } from "lucide-react";
import { LANGUAGES, type ExplainMode, type ExplainRequest, type LangCode } from "../../shared/types.ts";
import { RichText } from "./RichText.tsx";
import { useAiStream } from "./useAiStream.ts";

export type Note = {
  id: string;
  chapterId: string;
  blockId: string;
  /** The text the reader selected. */
  quote: string;
  mode: ExplainMode;
  /** The language it was asked in. A card keeps it: picking another language later must not ask again. */
  lang: LangCode;
};

type Props = {
  note: Note;
  bookId: string;
  /** `byKeyboard`: pressed with Enter or Space, so focus was on the button that is about to go. */
  onClose: (id: string, byKeyboard: boolean) => void;
};

function label(mode: ExplainMode, lang: LangCode): string {
  if (mode === "example") return "Example";
  if (mode === "native") return `In ${LANGUAGES[lang]}`;
  return "Explanation";
}

/** One explanation, shown in the margin beside the paragraph it belongs to. */
export function NoteCard({ note, bookId, onClose }: Props) {
  const { lang } = note;
  const request: ExplainRequest = {
    bookId,
    chapterId: note.chapterId,
    blockId: note.blockId,
    selection: note.quote,
    mode: note.mode,
    lang,
  };
  const answer = useAiStream("/api/ai/explain", request);

  return (
    <aside className="note" data-note={note.id} aria-label={`${label(note.mode, lang)}: ${note.quote.slice(0, 60)}`}>
      <header className="note-head">
        <span className="note-label">{label(note.mode, lang)}</span>
        <button type="button" className="icon-button" aria-label="Remove note" onClick={(event) => onClose(note.id, event.detail === 0)}>
          <X size={16} aria-hidden />
        </button>
      </header>
      <blockquote className="note-quote">{note.quote}</blockquote>
      <div
        aria-live="polite"
        aria-busy={answer.status === "loading"}
        className={note.mode === "native" ? "note-native" : undefined}
        lang={note.mode === "native" ? lang : undefined}
      >
        {answer.text ? (
          <RichText text={answer.text} writing={answer.status === "loading"} />
        ) : (
          answer.status === "loading" && (
            <p className="note-wait" lang="en">
              Reading the passage...
              <span className="skeleton" />
              <span className="skeleton" style={{ width: "70%" }} />
            </p>
          )
        )}
      </div>
      {answer.status === "error" && (
        <p className="inline-error">
          {answer.error}{" "}
          <button type="button" className="link-button" onClick={answer.retry}>
            Try again
          </button>
        </p>
      )}
    </aside>
  );
}
