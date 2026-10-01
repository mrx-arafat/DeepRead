import { X } from "lucide-react";
import { LANGUAGES, type ExplainMode, type ExplainRequest, type LangCode } from "../../shared/types.ts";
import { RichText } from "./RichText.tsx";
import { useAiStream } from "./useAiStream.ts";

export type Note = {
  id: string;
  blockId: string;
  /** The text the reader selected. */
  quote: string;
  mode: ExplainMode;
};

type Props = {
  note: Note;
  bookId: string;
  chapterId: string;
  lang: LangCode;
  onClose: (id: string) => void;
};

function label(mode: ExplainMode, lang: LangCode): string {
  if (mode === "example") return "Example";
  if (mode === "native") return `In ${LANGUAGES[lang]}`;
  return "Explanation";
}

/** One explanation, shown in the margin beside the paragraph it belongs to. */
export function NoteCard({ note, bookId, chapterId, lang, onClose }: Props) {
  const request: ExplainRequest = {
    bookId,
    chapterId,
    blockId: note.blockId,
    selection: note.quote,
    mode: note.mode,
    lang,
  };
  const answer = useAiStream("/api/ai/explain", request);

  return (
    <aside className="note" aria-label={`${label(note.mode, lang)}: ${note.quote.slice(0, 60)}`}>
      <header className="note-head">
        <span className="note-label">{label(note.mode, lang)}</span>
        <button type="button" className="icon-button" aria-label="Remove note" onClick={() => onClose(note.id)}>
          <X size={16} aria-hidden />
        </button>
      </header>
      <blockquote className="note-quote">{note.quote}</blockquote>
      <div aria-live="polite" lang={note.mode === "native" ? lang : undefined}>
        {answer.text ? (
          <RichText text={answer.text} />
        ) : (
          answer.status === "loading" && (
            <p className="note-wait">
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
