import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "../../shared/types.ts";
import { speak, whenVoiceFree } from "./speech.ts";
import { placeInView, scrollTopFor, type Place } from "./sentenceView.ts";
import { rangeInBlock, sentenceIndex, sentencesOf, setHighlight, wordAt, type SentenceAt } from "./textRanges.ts";

export type Listen = {
  /** The player is open (playing or paused). */
  active: boolean;
  playing: boolean;
  error: string | null;
  /** The sentence being read is out of the reader's view, above or below it. */
  away: Exclude<Place, "in"> | null;
  /** Bring the sentence being read back into view. */
  showSentence: () => void;
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
  const [away, setAway] = useState<Listen["away"]>(null);
  // Bumped to scroll the sentence into view because the reader asked for it (Play, Next, the back button).
  const [reveal, setReveal] = useState(0);
  const shown = useRef<Range | null>(null);
  // When the player last scrolled the page: a smooth scroll still under way is not the reader leaving.
  const scrolledAt = useRef(-Infinity);

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

  const scrollTo = useCallback((range: Range) => {
    const top = scrollTopFor(range.getBoundingClientRect(), window.innerHeight, window.scrollY);
    if (top === null) return;
    scrolledAt.current = performance.now();
    window.scrollTo({ top, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (!sentence) {
      shown.current = null;
      setHighlight("dr-sentence", null);
      return;
    }
    const range = rangeInBlock(sentence.blockId, sentence);
    setHighlight("dr-sentence", range);
    const before = shown.current;
    shown.current = range;
    // The page follows the voice only while the reader is still with it. One who scrolled away to read
    // ahead or look at a note is left where they are: the player offers a way back instead.
    const withReader =
      !before ||
      placeInView(before.getBoundingClientRect(), window.innerHeight) === "in" ||
      performance.now() - scrolledAt.current < 1500;
    if (range && withReader) scrollTo(range);
    return () => setHighlight("dr-sentence", null);
  }, [place]);

  // Asked for by the reader: show the sentence wherever the page is. Declared after the effect above, which
  // has set `shown` by the time a request for a new sentence runs.
  useEffect(() => {
    if (reveal && shown.current) scrollTo(shown.current);
  }, [reveal]);

  // Tell the reader when the sentence is out of view. Waits for scrolling to settle, so the page following
  // the voice does not make the answer flicker.
  useEffect(() => {
    if (!sentence) {
      setAway(null);
      return;
    }
    let timer: number | undefined;
    const measure = () => {
      const range = shown.current;
      const where = range ? placeInView(range.getBoundingClientRect(), window.innerHeight) : "in";
      setAway(where === "in" ? null : where);
    };
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 150);
    };
    soon();
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", soon);
      window.removeEventListener("resize", soon);
    };
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
  const showSentence = useCallback(() => setReveal((count) => count + 1), []);

  return { active: sentence !== null, playing, error, away, showSentence, toggle, stop, next, previous, startAt };
}
