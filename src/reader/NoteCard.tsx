import { BookmarkCheck, BookmarkPlus, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { LANGUAGES, MAX_SAVED_ANSWER_CHARS, type ExplainMode, type ExplainRequest, type LangCode, type QuestionNote } from "../../shared/types.ts";
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
  onSaveAnswer: (note: QuestionNote, answer: string) => void;
};

function label(mode: ExplainMode, lang: LangCode): string {
  if (mode === "example") return "Example";
  if (mode === "native") return `In ${LANGUAGES[lang]}`;
  return "Explanation";
}

/** One explanation, shown in the margin beside the paragraph it belongs to. */
export function NoteCard({ note, bookId, latest, onClose, onSaveAnswer }: Props) {
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
  const answer = useAiStream("/api/ai/explain", request, !note.savedAnswer);
  const text = note.savedAnswer ?? answer.text;
  // Folding only hides something when the answer has more than one part.
  const more = parseSections(text).length > 1;
  const saved = Boolean(note.savedAnswer);
  const canSave = !saved && answer.status === "done" && Boolean(answer.text.trim()) && answer.text.length <= MAX_SAVED_ANSWER_CHARS;
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
        aria-busy={!note.savedAnswer && answer.status === "loading"}
        className={note.mode === "native" ? "note-body note-native" : "note-body"}
        lang={note.mode === "native" ? lang : undefined}
      >
        {text ? (
          <RichText text={text} writing={!note.savedAnswer && answer.status === "loading"} />
        ) : (
          !note.savedAnswer && answer.status === "loading" && (
            <p className="note-wait" lang="en">
              Reading the passage...
              <span className="skeleton" />
              <span className="skeleton" style={{ width: "70%" }} />
            </p>
          )
        )}
      </div>
      {!note.savedAnswer && answer.status === "error" && (
        <p className="inline-error">
          {answer.error}{" "}
          <button type="button" className="link-button" onClick={answer.retry}>
            Try again
          </button>
        </p>
      )}
      {(saved || canSave || more) && (
        // Below the answer, never over it: the answer scrolls on its own and fades out above this line.
        <footer className="note-foot">
          {saved ? (
            <p className="note-saved">
              <BookmarkCheck size={16} aria-hidden /> Saved to notebook
            </p>
          ) : canSave ? (
            <button type="button" className="quiet-button note-save" onClick={() => onSaveAnswer(note, answer.text)}>
              <BookmarkPlus size={16} aria-hidden /> Save to notebook
            </button>
          ) : null}
          {more && (
            <button type="button" className="link-button note-more" aria-expanded={open} onClick={() => setUnfolded(!open)}>
              {open ? "Show less" : "Show more"}
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}
