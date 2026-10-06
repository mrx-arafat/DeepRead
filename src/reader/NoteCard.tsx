import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { LANGUAGES, type ExplainMode, type ExplainRequest, type LangCode, type QuestionNote } from "../../shared/types.ts";
import { parseSections, RichText } from "./RichText.tsx";
import { useAiStream } from "./useAiStream.ts";

type Props = {
  /** A question: a highlight is painted on the text, never shown as a card. */
  note: QuestionNote;
  bookId: string;
  /** The most recently asked note. In the margin only it shows its whole answer; older cards fold to their first part. */
  latest: boolean;
  /** `byKeyboard`: pressed with Enter or Space, so focus was on the button that is about to go. */
  onClose: (id: string, byKeyboard: boolean) => void;
};

function label(mode: ExplainMode, lang: LangCode): string {
  if (mode === "example") return "Example";
  if (mode === "native") return `In ${LANGUAGES[lang]}`;
  return "Explanation";
}

/** One explanation, shown in the margin beside the paragraph it belongs to. */
export function NoteCard({ note, bookId, latest, onClose }: Props) {
  const { lang } = note;
  // Folded unless it is the newest card, until the reader opens or folds it themselves.
  const [unfolded, setUnfolded] = useState<boolean | null>(null);
  const open = unfolded ?? latest;
  const request: ExplainRequest = {
    bookId,
    chapterId: note.chapterId,
    blockId: note.blockId,
    selection: note.quote,
    mode: note.mode,
    lang,
  };
  const answer = useAiStream("/api/ai/explain", request);
  // Folding only hides something when the answer has more than one part.
  const more = parseSections(answer.text).length > 1;
  const panelRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const setPanelHeight = () => {
      const top = panel.getBoundingClientRect().top;
      const footerTop = document.querySelector(".reading-footer")?.getBoundingClientRect().top ?? window.innerHeight;
      const bottom = Math.min(window.innerHeight, footerTop) - 12;
      panel.style.setProperty("--panel-max", `${Math.max(48, bottom - top)}px`);
    };
    setPanelHeight();
    window.addEventListener("resize", setPanelHeight);
    window.addEventListener("scroll", setPanelHeight, { passive: true });
    return () => {
      window.removeEventListener("resize", setPanelHeight);
      window.removeEventListener("scroll", setPanelHeight);
    };
  }, [open]);

  return (
    <aside
      ref={panelRef}
      className="note"
      data-note={note.id}
      data-folded={open ? undefined : ""}
      aria-label={`${label(note.mode, lang)}: ${note.quote.slice(0, 60)}`}
    >
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
        className={note.mode === "native" ? "note-body note-native" : "note-body"}
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
      {more && (
        <button type="button" className="link-button note-more" aria-expanded={open} onClick={() => setUnfolded(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
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
