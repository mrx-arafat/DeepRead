import { BookmarkPlus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { MAX_REFLECTION_CHARS } from "../../shared/types.ts";

type Props = {
  /** The chat the answer came from, named at the top of what is kept: "From ChatGPT:". */
  from: string;
  onSave: (text: string) => void;
};

/** A box for what the outside chat answered. Kept with the passage as a reflection, so it is in the notebook and its export. */
export function PasteAnswer({ from, onSave }: Props) {
  const id = useId();
  const [text, setText] = useState("");
  const prefix = `From ${from}:\n`;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim()) onSave(`${prefix}${text.trim()}`);
  }
  return (
    <form className="note-paste" onSubmit={submit}>
      <label htmlFor={id}>Paste the answer</label>
      <textarea
        id={id}
        value={text}
        rows={4}
        maxLength={MAX_REFLECTION_CHARS - prefix.length}
        placeholder={`What ${from} answered`}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="quiet-button note-save" disabled={!text.trim()}>
        <BookmarkPlus size={16} aria-hidden /> Save to notebook
      </button>
    </form>
  );
}
