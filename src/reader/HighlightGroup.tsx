import { Check, Eraser, Highlighter } from "lucide-react";
import { HIGHLIGHT_COLORS, type HighlightColor } from "../../shared/types.ts";

export type HighlightChoice = {
  /** The colour a new highlight takes (the one used last), or the colour of the highlight the selection lies in. */
  color: HighlightColor;
  /** The selection lies inside a highlight: the colours change that highlight, and Remove takes it away. */
  editing: boolean;
  onPick: (color: HighlightColor) => void;
  onRemove: () => void;
};

/**
 * The selection bar's highlighter: a button for the colour used last and a swatch for each colour, or, on a passage
 * already highlighted, the swatches to change its colour and a button to remove it. Each colour is named, and the
 * chosen one is ticked, so none of it rests on telling colours apart.
 */
export function HighlightGroup({ color, editing, onPick, onRemove }: HighlightChoice) {
  return (
    <div className="selection-highlight" role="group" aria-label={editing ? "Change highlight" : "Highlight"}>
      {!editing && (
        <button type="button" aria-label={`Highlight in ${color}`} title={`Highlight in ${color}`} onClick={() => onPick(color)}>
          <Highlighter size={16} aria-hidden /> Highlight
        </button>
      )}
      {HIGHLIGHT_COLORS.map((choice) => (
        <button
          key={choice}
          type="button"
          className="selection-swatch"
          data-color={choice}
          aria-label={`Highlight ${choice}`}
          aria-pressed={choice === color}
          title={`Highlight ${choice}`}
          onClick={() => onPick(choice)}
        >
          <span className="selection-swatch-dot" aria-hidden>
            {choice === color && <Check size={14} strokeWidth={3} />}
          </span>
        </button>
      ))}
      {editing && (
        <button type="button" aria-label="Remove highlight" title="Remove highlight" onClick={onRemove}>
          <Eraser size={16} aria-hidden /> Remove
        </button>
      )}
    </div>
  );
}
