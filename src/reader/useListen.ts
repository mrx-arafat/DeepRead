import { useCallback, useEffect, useMemo, useState } from "react";
import type { Block } from "../../shared/types.ts";
import { speak } from "./speech.ts";
import { rangeInBlock, sentenceSpans, setHighlight, wordAt, type Span } from "./textRanges.ts";

type Sentence = Span & { blockId: string; text: string };

export type Listen = {
  /** The player is open (playing or paused). */
  active: boolean;
  playing: boolean;
  error: string | null;
  toggle: () => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
  /** Start reading at the sentence containing `offset` of the given block. */
  startAt: (blockId: string, offset?: number) => void;
};

/** Reads the chapter aloud one sentence at a time, highlighting the sentence and word being spoken. */
export function useListen(blocks: Block[], rate: number): Listen {
  const sentences = useMemo<Sentence[]>(
    () =>
      blocks.flatMap((block) =>
        sentenceSpans(block.text).map((span) => ({
          ...span,
          blockId: block.id,
          text: block.text.slice(span.start, span.end),
        })),
      ),
    [blocks],
  );
  const [index, setIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new chapter means a new sentence list: close the player.
  useEffect(() => {
    setIndex(null);
    setPlaying(false);
    setError(null);
  }, [sentences]);

  const sentence = index === null ? null : (sentences[index] ?? null);

  useEffect(() => {
    if (!sentence) {
      setHighlight("dr-sentence", null);
      return;
    }
    const range = rangeInBlock(sentence.blockId, sentence);
    setHighlight("dr-sentence", range);
    const rect = range?.getBoundingClientRect();
    // Keep the spoken sentence inside the comfortable middle of the window.
    if (rect && (rect.top < 90 || rect.bottom > window.innerHeight - 140)) {
      window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight * 0.3, behavior: "smooth" });
    }
    return () => setHighlight("dr-sentence", null);
  }, [sentence]);

  useEffect(() => {
    if (!playing || !sentence) return;
    const cancel = speak(sentence.text, {
      rate,
      onWord: (start) => {
        const word = wordAt(sentence.text, start);
        const span = word && { start: sentence.start + word.start, end: sentence.start + word.end };
        setHighlight("dr-spoken", span ? rangeInBlock(sentence.blockId, span) : null);
      },
      onEnd: () => {
        if (index !== null && index + 1 < sentences.length) setIndex(index + 1);
        else setPlaying(false);
      },
      onError: (message) => {
        setPlaying(false);
        setError(message);
      },
    });
    return () => {
      cancel();
      setHighlight("dr-spoken", null);
    };
  }, [playing, sentence, index, rate, sentences.length]);

  const move = useCallback(
    (step: number) =>
      setIndex((current) =>
        current === null ? null : Math.min(Math.max(current + step, 0), sentences.length - 1),
      ),
    [sentences.length],
  );

  const startAt = useCallback(
    (blockId: string, offset = 0) => {
      let target = sentences.findIndex((s) => s.blockId === blockId && offset < s.end);
      if (target === -1) target = sentences.findIndex((s) => s.blockId === blockId);
      if (target === -1) return;
      setError(null);
      setIndex(target);
      setPlaying(true);
    },
    [sentences],
  );

  return {
    active: index !== null,
    playing,
    error,
    toggle: () => {
      setError(null);
      setPlaying((value) => !value);
    },
    stop: () => {
      setPlaying(false);
      setIndex(null);
    },
    next: () => move(1),
    previous: () => move(-1),
    startAt,
  };
}
