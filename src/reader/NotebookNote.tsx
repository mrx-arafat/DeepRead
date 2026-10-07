import { ArrowLeft, Highlighter, Lightbulb, MapPin, Pencil, PencilLine, Trash2 } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { Note, ReflectionNote } from "../../shared/types.ts";
import { entryKind, entryLabel, entryNoun, type EntryKind } from "./notebookEntries.ts";
import { RichText } from "./RichText.tsx";

const ICONS: Record<EntryKind, typeof Highlighter> = { highlight: Highlighter, answer: Lightbulb, reflection: PencilLine };

/** The entry's kind as a small icon and its name, as the list and the open note both show it. */
export function EntryTag({ note }: { note: Note }) {
  const kind = entryKind(note);
  const Icon = ICONS[kind];
  return (
    <span className="notebook-tag" data-kind={kind}>
      {note.mode === "highlight" ? <span className="notebook-swatch" data-color={note.color} aria-hidden /> : <Icon size={14} aria-hidden />}
      {entryLabel(note)}
    </span>
  );
}

type Props = {
  note: Note;
  chapterTitle: string;
  /** Back to the list, where the list and the note do not fit side by side. */
  onBack: () => void;
  onOpenSource: () => void;
  onEdit: (note: ReflectionNote) => void;
  onRemove: () => void;
  /** Why the passage could not be opened, shown with the actions. */
  error?: ReactNode;
};

/** One Notebook entry in full: the passage, then the reader's words or the saved answer, formatted as in the margin. */
export function NotebookNote({ note, chapterTitle, onBack, onOpenSource, onEdit, onRemove, error }: Props) {
  const titleId = useId();
  const noun = entryNoun(note);
  return (
    <article className="notebook-note" aria-labelledby={titleId}>
      <button type="button" className="link-button notebook-note__back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden /> All notes
      </button>
      <header className="notebook-note__head">
        <h3 id={titleId}><EntryTag note={note} /></h3>
        <p>{chapterTitle}</p>
      </header>
      <blockquote className="notebook-note__quote" data-color={note.mode === "highlight" ? note.color : undefined}>{note.quote}</blockquote>
      {note.mode === "reflection" ? (
        <div className="notebook-note__words notebook-note__reflection">
          {note.text.split(/\n{2,}/).map((part, index) => <p key={index}>{part}</p>)}
        </div>
      ) : note.mode !== "highlight" && note.savedAnswer ? (
        <div className="notebook-note__words"><RichText text={note.savedAnswer} /></div>
      ) : null}
      {error}
      <div className="notebook-note__actions">
        <button type="button" className="quiet-button" onClick={onOpenSource}><MapPin size={17} aria-hidden /> Open passage</button>
        {note.mode === "reflection" && <button type="button" className="quiet-button" onClick={() => onEdit(note)}><Pencil size={17} aria-hidden /> Edit</button>}
        <button type="button" className="icon-button" aria-label={`Remove ${noun}`} title={`Remove ${noun}`} onClick={onRemove}><Trash2 size={18} aria-hidden /></button>
      </div>
    </article>
  );
}
