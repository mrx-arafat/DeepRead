import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "../../shared/types.ts";
import { speak, whenVoiceFree } from "./speech.ts";
import { placeInView, scrollTopFor, type Place } from "./sentenceView.ts";
import { rangeInBlock, sentenceIndex, sentencesOf, setHighlight, wordAt, type SentenceAt } from "./textRanges.ts";
import { forSpeech, pauseBetween } from "./voicing.ts";

/** What the page can say about the chapter that follows the last one on it. */
export type NextChapter = {
  /** Another chapter follows the last one on the page. */
  coming: boolean;
  /** Why it could not be opened, if it could not. */
  error: string | null;
  /** Ask for it now: the page only loads it once the reader scrolls near the end. */
  open: () => void;
};

export type Listen = {
  /** The player is open (playing or paused). */
  active: boolean;
  playing: boolean;
  error: string | null;
  /** The voice reached the end of what is loaded and is waiting for the next chapter (or for a retry). */
  waiting: "opening" | "failed" | null;
  /** Try again to open the next chapter. */
  retry: () => void;
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
  /** Start reading at the sentence of the given block that is at `line` (window y), or the first one under it. */
  startAtLine: (blockId: string, line: number) => void;
};

/**
 * Reads the book aloud one sentence at a time, highlighting the sentence and word being spoken.
 * `blocks` are all the blocks on the page, in order; it may grow while reading, and reading carries on into it.
 */
export function useListen(blocks: Block[], rate: number, nextChapter: NextChapter): Listen {
  const sentences = useMemo(() => sentencesOf(blocks), [blocks]);
  const [at, setAt] = useState<SentenceAt | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to carry on with the sentence after something else (a word from its card) had the voice.
  const [again, setAgain] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [away, setAway] = useState<Listen["away"]>(null);
  // Bumped to scroll the sentence into view because the reader asked for it (Play, Next, the back button).
  const [reveal, setReveal] = useState(0);
  const shown = useRef<Range | null>(null);
  // When the player last scrolled the page: a smooth scroll still under way is not the reader leaving.
  const scrolledAt = useRef(-Infinity);
  // The word the voice is on. Play after a pause, a new speed, or a word said from its card carry on from that word
  // instead of the sentence's beginning. The engines' own pause and resume are not used: Chrome on Android has no
  // pause, and its network voices stall after a resume.
  const resume = useRef<{ place: string; offset: number } | null>(null);
  // The silence to leave before the next sentence starts, when reading carries on by itself (see voicing.ts).
  const gap = useRef(0);
  const titles = useMemo(() => new Set(blocks.filter((block) => block.type === "heading").map((block) => block.id)), [blocks]);

  const index = useMemo(() => (at ? sentenceIndex(sentences, at) : -1), [sentences, at]);
  const sentence = index === -1 ? null : (sentences[index] ?? null);
  // The effects below key on where the sentence is, not on the object: re-renders and appended chapters
  // must not restart the sentence being spoken.
  const place = sentence && `${sentence.blockId}:${sentence.start}`;

  // When a sentence ends, the next one is looked up in the newest list: a chapter may have arrived meanwhile.
  const latest = useRef(sentences);
  const following = useRef(nextChapter);
  useEffect(() => {
    latest.current = sentences;
    following.current = nextChapter;
  }, [sentences, nextChapter]);

  // Reading reached the end of what is loaded: carry on as soon as the next chapter arrives.
  useEffect(() => {
    if (!waiting || !at) return;
    const done = sentenceIndex(sentences, at);
    const after = done === -1 ? undefined : sentences[done + 1];
    if (!after) return;
    setWaiting(false);
    gap.current = pauseBetween({ blockId: at.blockId, title: false }, after, rate);
    setAt({ blockId: after.blockId, start: after.start });
  }, [waiting, sentences, at]);

  // The sentence is gone from the page (the reader opened another part of the book): close the player.
  useEffect(() => {
    if (!at || index !== -1) return;
    setAt(null);
    setPlaying(false);
    setWaiting(false);
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
    if (!playing || !sentence || !place) return;
    setWaiting(false);
    const from = resume.current?.place === place ? resume.current.offset : 0;
    const voiced = forSpeech(sentence.text.slice(from));
    // A pause or a new speed during the silence starts this sentence at once when the reader presses Play again.
    const silence = gap.current;
    gap.current = 0;
    let unwait = () => {};
    let cancel = () => {};
    const start = () => {
      cancel = speak(voiced.text, {
        rate,
        onWord: (offset) => {
          const word = wordAt(sentence.text, from + voiced.original(offset));
          if (word) resume.current = { place, offset: word.start };
          const span = word && { start: sentence.start + word.start, end: sentence.start + word.end };
          setHighlight("dr-spoken", span ? rangeInBlock(sentence.blockId, span) : null);
        },
        onEnd: () => {
          resume.current = null;
          const list = latest.current;
          const done = sentenceIndex(list, sentence);
          const after = done === -1 ? undefined : list[done + 1];
          if (after) {
            gap.current = pauseBetween({ blockId: sentence.blockId, title: titles.has(sentence.blockId) }, after, rate);
            setAt({ blockId: after.blockId, start: after.start });
          } else if (following.current.coming) {
            // The next chapter is not on the page yet: ask for it (the reader may be far from where it loads
            // by itself) and carry on when it arrives.
            setWaiting(true);
            following.current.open();
          } else {
            setPlaying(false);
          }
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
    };
    const timer = silence > 0 ? window.setTimeout(start, silence) : undefined;
    if (!timer) start();
    return () => {
      window.clearTimeout(timer);
      unwait();
      cancel();
      setHighlight("dr-spoken", null);
    };
  }, [playing, place, rate, again]);

  const move = useCallback(
    (step: number) => {
      resume.current = null;
      setAt((current) => {
        const from = current ? sentenceIndex(sentences, current) : -1;
        if (from === -1) return current;
        const target = sentences[Math.min(Math.max(from + step, 0), sentences.length - 1)];
        return target ? { blockId: target.blockId, start: target.start } : current;
      });
      // The reader asked for it from the player: show where the voice is, wherever the page was left.
      setReveal((count) => count + 1);
    },
    [sentences],
  );

  const begin = useCallback((target: SentenceAt | undefined) => {
    if (!target) return;
    resume.current = null;
    setError(null);
    setAt({ blockId: target.blockId, start: target.start });
    setPlaying(true);
  }, []);

  const startAt = useCallback(
    (blockId: string, offset = 0) =>
      begin(sentences.find((s) => s.blockId === blockId && offset < s.end) ?? sentences.find((s) => s.blockId === blockId)),
    [sentences, begin],
  );

  const startAtLine = useCallback(
    (blockId: string, line: number) => {
      const inBlock = sentences.filter((s) => s.blockId === blockId);
      // The first sentence that still reaches below the line: the one being read there, not the paragraph's first.
      const reaching = inBlock.find((s) => (rangeInBlock(blockId, s)?.getBoundingClientRect().bottom ?? 0) > line);
      begin(reaching ?? inBlock[0]);
    },
    [sentences, begin],
  );

  const toggle = useCallback(() => {
    setError(null);
    setWaiting(false);
    // Pressing Play brings the sentence about to be read into view, so the page and the voice agree.
    if (!playing) setReveal((count) => count + 1);
    setPlaying(!playing);
  }, [playing]);

  const stop = useCallback(() => {
    resume.current = null;
    setPlaying(false);
    setWaiting(false);
    setAt(null);
  }, []);

  const forward = useCallback(() => move(1), [move]);
  const previous = useCallback(() => move(-1), [move]);
  const retry = useCallback(() => following.current.open(), []);
  const showSentence = useCallback(() => setReveal((count) => count + 1), []);

  return {
    active: sentence !== null,
    playing,
    error,
    waiting: waiting ? (nextChapter.error ? "failed" : "opening") : null,
    retry,
    away,
    showSentence,
    toggle,
    stop,
    next: forward,
    previous,
    startAt,
    startAtLine,
  };
}
