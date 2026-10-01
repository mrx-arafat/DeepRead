import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "../../shared/types.ts";
import { speak, whenVoiceFree } from "./speech.ts";
import { rangeInBlock, sentenceIndex, sentencesOf, setHighlight, wordAt, type SentenceAt } from "./textRanges.ts";

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

/**
 * Reads the book aloud one sentence at a time, highlighting the sentence and word being spoken.
 * `blocks` are all the blocks on the page, in order; it may grow while reading, and reading carries on into it.
 */
export function useListen(blocks: Block[], rate: number): Listen {
  const sentences = useMemo(() => sentencesOf(blocks), [blocks]);
  const [at, setAt] = useState<SentenceAt | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to speak the sentence again after something else (a word from its card) had the voice.
  const [again, setAgain] = useState(0);

  const index = useMemo(() => (at ? sentenceIndex(sentences, at) : -1), [sentences, at]);
  const sentence = index === -1 ? null : (sentences[index] ?? null);
  // The effects below key on where the sentence is, not on the object: re-renders and appended chapters
  // must not restart the sentence being spoken.
  const place = sentence && `${sentence.blockId}:${sentence.start}`;

  // When a sentence ends, the next one is looked up in the newest list: a chapter may have arrived meanwhile.
  const latest = useRef(sentences);
  useEffect(() => {
    latest.current = sentences;
  }, [sentences]);

  // The sentence is gone from the page (the reader opened another part of the book): close the player.
  useEffect(() => {
    if (!at || index !== -1) return;
    setAt(null);
    setPlaying(false);
    setError(null);
  }, [at, index]);

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
  }, [place]);

  useEffect(() => {
    if (!playing || !sentence) return;
    let unwait = () => {};
    const cancel = speak(sentence.text, {
      rate,
      onWord: (start) => {
        const word = wordAt(sentence.text, start);
        const span = word && { start: sentence.start + word.start, end: sentence.start + word.end };
        setHighlight("dr-spoken", span ? rangeInBlock(sentence.blockId, span) : null);
      },
      onEnd: () => {
        const list = latest.current;
        const done = sentenceIndex(list, sentence);
        const next = done === -1 ? undefined : list[done + 1];
        // Nothing loaded after this sentence yet: pause here, the player stays open.
        if (next) setAt({ blockId: next.blockId, start: next.start });
        else setPlaying(false);
      },
      // Something else took the voice (a word said from its card): carry on with this sentence once it is done.
      onInterrupted: () => {
        unwait = whenVoiceFree(() => setAgain((count) => count + 1));
      },
      onError: (message) => {
        setPlaying(false);
        setError(message);
      },
    });
    return () => {
      unwait();
      cancel();
      setHighlight("dr-spoken", null);
    };
  }, [playing, place, rate, again]);

  const move = useCallback(
    (step: number) =>
      setAt((current) => {
        const from = current ? sentenceIndex(sentences, current) : -1;
        if (from === -1) return current;
        const target = sentences[Math.min(Math.max(from + step, 0), sentences.length - 1)];
        return target ? { blockId: target.blockId, start: target.start } : current;
      }),
    [sentences],
  );

  const startAt = useCallback(
    (blockId: string, offset = 0) => {
      const target =
        sentences.find((s) => s.blockId === blockId && offset < s.end) ?? sentences.find((s) => s.blockId === blockId);
      if (!target) return;
      setError(null);
      setAt({ blockId: target.blockId, start: target.start });
      setPlaying(true);
    },
    [sentences],
  );

  const toggle = useCallback(() => {
    setError(null);
    setPlaying((value) => !value);
  }, []);

  const stop = useCallback(() => {
    setPlaying(false);
    setAt(null);
  }, []);

  const next = useCallback(() => move(1), [move]);
  const previous = useCallback(() => move(-1), [move]);

  return { active: sentence !== null, playing, error, toggle, stop, next, previous, startAt };
}
