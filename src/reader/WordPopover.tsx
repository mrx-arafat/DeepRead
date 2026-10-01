import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import { Headphones, Volume2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { LANGUAGES, type ExplainRequest, type LangCode } from "../../shared/types.ts";
import { api } from "../api.ts";
import { canSpeak, speak } from "./speech.ts";
import { blockOf } from "./textRanges.ts";
import { useAiStream } from "./useAiStream.ts";

export type Lookup = {
  range: Range;
  text: string;
  chapterId: string;
  blockId: string;
  /** Asked for from the keyboard, so the bar that opens takes focus. */
  keyboard?: boolean;
};

type Props = {
  lookup: Lookup;
  bookId: string;
  lang: LangCode;
  onListenFromHere: () => void;
  onClose: () => void;
};

/** Pull "Label: value" lines out of the tutor's word answer, tolerating a half-streamed reply. */
function labelled(text: string): Map<string, string> {
  const lines = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\**([^:*]{2,20})\**:\**\s*(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) lines.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return lines;
}

export function WordPopover({ lookup, bookId, lang, onListenFromHere, onClose }: Props) {
  const { refs, floatingStyles } = useFloating({
    placement: "bottom",
    middleware: [offset(10), flip({ padding: 64 }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  useLayoutEffect(() => {
    refs.setPositionReference({
      getBoundingClientRect: () => lookup.range.getBoundingClientRect(),
      getClientRects: () => lookup.range.getClientRects(),
    });
  }, [refs, lookup.range]);

  // The card takes focus so it is announced and its buttons are next for a keyboard;
  // closing it from inside (Escape, Close, Listen) hands focus back to the paragraph.
  useLayoutEffect(() => {
    const card = refs.floating.current;
    card?.focus({ preventScroll: true });
    return () => {
      if (!card?.contains(document.activeElement)) return;
      // React ignores focus events while it commits, so the paragraph takes focus once the card is gone.
      const block = blockOf(lookup.range.startContainer);
      queueMicrotask(() => block?.focus({ preventScroll: true }));
    };
  }, [refs, lookup.range]);

  // A keyless dictionary translation, kept only as a fallback: it ignores the sentence, so it can pick
  // the wrong sense ("minute" as time). The tutor's in-context answer is what the reader normally sees.
  const [quick, setQuick] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setQuick(null);
    api
      .translate(lookup.text, lang, controller.signal)
      .then((result) => setQuick(result.translation))
      .catch(() => {
        // Only a fallback; the tutor's answer carries the translation.
      });
    return () => controller.abort();
  }, [lookup.text, lang]);

  const request: ExplainRequest = {
    bookId,
    chapterId: lookup.chapterId,
    blockId: lookup.blockId,
    selection: lookup.text,
    mode: "word",
    lang,
  };
  const answer = useAiStream("/api/ai/explain", request);
  const lines = labelled(answer.text);
  const language = LANGUAGES[lang];
  const native = lines.get(language.toLowerCase()) ?? (answer.status === "error" ? quick : null);
  const meaning = lines.get("meaning");
  const example = lines.get("example");

  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className="popover word-popover"
      tabIndex={-1}
      role="dialog"
      aria-label={`Meaning of ${lookup.text}`}
    >
      <header className="word-head">
        <span className="word-term">{lookup.text}</span>
        {canSpeak && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Say ${lookup.text}`}
            onClick={() => speak(lookup.text)}
          >
            <Volume2 size={18} aria-hidden />
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </header>

      <p className="word-native" lang={lang} aria-live="polite">
        {native ?? <span className="skeleton" style={{ width: "7rem" }} />}
      </p>

      <dl className="word-lines" aria-live="polite">
        <dt>Meaning</dt>
        <dd>{meaning ?? (answer.status === "error" ? "" : <span className="skeleton" />)}</dd>
        {(example || answer.status === "loading") && (
          <>
            <dt>Example</dt>
            <dd>{example ?? <span className="skeleton" />}</dd>
          </>
        )}
      </dl>

      {answer.status === "error" && (
        <p className="inline-error">
          {answer.error}{" "}
          <button type="button" className="link-button" onClick={answer.retry}>
            Try again
          </button>
        </p>
      )}

      {canSpeak && (
        <button type="button" className="quiet-button" onClick={onListenFromHere}>
          <Headphones size={16} aria-hidden /> Listen from here
        </button>
      )}
    </div>
  );
}
