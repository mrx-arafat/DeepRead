import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import { Headphones, Volume2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { LANGUAGES, type ExplainRequest, type LangCode } from "../../shared/types.ts";
import { api } from "../api.ts";
import { BOTTOM_EDGE, clearSpan, TOP_EDGE } from "./sentenceView.ts";
import { canSpeak, speak } from "./speech.ts";
import { blockOf, highlighted, rangeInBlock, sentenceSpans } from "./textRanges.ts";
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

// Wide enough for the margin beside the text: the width at which notes move there too (styles.css).
const MARGIN = "(min-width: 72rem)";
// The card stays clear of the top bar and the player.
const EDGES = { top: TOP_EDGE + 12, bottom: BOTTOM_EDGE };
const GAP = 10;

function watchMargin(onChange: () => void): () => void {
  const query = window.matchMedia(MARGIN);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function hasMargin(): boolean {
  return window.matchMedia(MARGIN).matches;
}

/** `--gutter` in pixels: how far the notes in the margin sit from the text. */
function gutter(): number {
  const root = getComputedStyle(document.documentElement);
  return parseFloat(root.getPropertyValue("--gutter")) * parseFloat(root.fontSize);
}

/** The sentences the card must leave in view, most important first: the one being read aloud, then the word's own. */
function sentencesToKeep(lookup: Lookup): Range[] {
  const own = sentenceSpans(lookup.range.startContainer.textContent ?? "").find(
    (span) => lookup.range.startOffset < span.end,
  );
  return [highlighted("dr-sentence"), own ? rangeInBlock(lookup.blockId, own) : null].filter((range) => range !== null);
}

export function WordPopover({ lookup, bookId, lang, onListenFromHere, onClose }: Props) {
  const margin = useSyncExternalStore(watchMargin, hasMargin);
  // Taken as the card opens, so it stays put while the voice moves on to the next sentence.
  const [keep] = useState(() => sentencesToKeep(lookup));
  // In the margin level with the word, like a note, where there is one. Elsewhere under or over the word,
  // clear of the sentence being read and of the word's own sentence.
  const { refs, floatingStyles } = useFloating({
    placement: margin ? "right-start" : "bottom",
    middleware: margin
      ? [offset(gutter()), shift({ padding: EDGES })]
      : [offset(GAP), flip({ padding: EDGES }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  useLayoutEffect(() => {
    refs.setPositionReference({
      getBoundingClientRect: () => {
        const word = lookup.range.getBoundingClientRect();
        if (margin) {
          const column = blockOf(lookup.range.startContainer)?.getBoundingClientRect() ?? word;
          return new DOMRect(column.left, word.top, column.width, word.height);
        }
        const card = (refs.floating.current?.offsetHeight ?? 0) + GAP;
        const view = { top: EDGES.top, bottom: window.innerHeight - EDGES.bottom };
        const span = clearSpan(word, keep.map((range) => range.getBoundingClientRect()), card, view);
        return new DOMRect(word.left, span.top, word.width, span.bottom - span.top);
      },
    });
  }, [refs, lookup.range, margin, keep]);

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

      {/* Without an answer (no AI helper, or it failed) there is nothing to label: the error below says why. */}
      {(meaning || answer.status !== "error") && (
        <dl className="word-lines" aria-live="polite">
          <dt>Meaning</dt>
          <dd>{meaning ?? <span className="skeleton" />}</dd>
          {(example || answer.status === "loading") && (
            <>
              <dt>Example</dt>
              <dd>{example ?? <span className="skeleton" />}</dd>
            </>
          )}
        </dl>
      )}

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
