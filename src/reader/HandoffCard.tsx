import { X } from "lucide-react";
import { HANDOFF_TARGETS, type HandoffTarget } from "./handoff.ts";
import { PasteAnswer } from "./PasteAnswer.tsx";

/** A passage handed to an outside chat from the selection bar: where its answer comes back to. A note only once the answer is pasted. */
export type SentPassage = { chapterId: string; blockId: string; quote: string; offset: number; target: HandoffTarget };

type Props = {
  sent: SentPassage;
  onClose: () => void;
  onSave: (sent: SentPassage, text: string) => void;
};

/** The card that keeps the reader's place while they are in the chat: the quote, and a box for the answer. */
export function HandoffCard({ sent, onClose, onSave }: Props) {
  const copyOnly = sent.target === "copy";
  const name = copyOnly ? "the chat" : HANDOFF_TARGETS[sent.target].name;
  const label = copyOnly ? "Prompt copied" : `Sent to ${name}`;
  return (
    <aside className="note note-sent" aria-label={`${label}: ${sent.quote.slice(0, 60)}`}>
      <header className="note-head">
        <span className="note-label">{label}</span>
        <button type="button" className="icon-button" aria-label="Remove note" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </header>
      <blockquote className="note-quote">{sent.quote}</blockquote>
      <p className="note-sent-hint">{copyOnly ? "Paste the prompt into your chat, then bring its answer back here." : `Press send in ${name}, then bring its answer back here.`}</p>
      <footer className="note-foot">
        <PasteAnswer from={name} onSave={(text) => onSave(sent, text)} />
      </footer>
    </aside>
  );
}
