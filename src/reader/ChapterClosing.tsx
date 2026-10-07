import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { Block, ChapterSummary, HighlightNote, LangCode, QuestionNote } from "../../shared/types.ts";
import { api } from "../api.ts";
import { usePrefs } from "../prefs.ts";
import { useAiStatus } from "./aiStatusStore.ts";
import { closingPreset, type ClosingFacts } from "./closingPresets.ts";

type Props = {
  bookId: string;
  chapterId: string;
  chapters: ChapterSummary[];
  /** The chapter's blocks in reading order. */
  blocks: Block[];
  /** The reader's questions and highlights for the whole book; only this chapter's count. */
  notes: QuestionNote[];
  highlights: HighlightNote[];
  lang: LangCode;
};

// Two screens below the window: asked for that early, the line is usually written by the time the reader gets there.
const NEAR = "0px 0px 200% 0px";

/**
 * The reader's highlights and questions on these blocks, in reading order: by block, then by where in the block they
 * start. A question keeps no offset, so it stands where its quote first appears. Block ids are unique in a book, so
 * the marks on a chapter's blocks are that chapter's marks.
 */
export function closingMarks(blocks: Block[], notes: QuestionNote[], highlights: HighlightNote[]): ClosingFacts["marks"] {
  const order = new Map(blocks.map((block, index) => [block.id, { index, text: block.text }]));
  return [...highlights, ...notes]
    .flatMap((note) => {
      const block = order.get(note.blockId);
      if (!block) return [];
      const start = note.mode === "highlight" ? note.offset : Math.max(0, block.text.indexOf(note.quote));
      return [{ block: block.index, start, mark: { quote: note.quote, mode: note.mode } }];
    })
    .sort((a, b) => a.block - b.block || a.start - b.start)
    .map(({ mark }) => mark);
}

/**
 * The line's sentences, each to be set on its own line: one looks back and one looks ahead, and a break inside a
 * sentence, where balanced lines would otherwise put it, reads as a stumble.
 */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.?]["'\u201D)]*)\s+(?=\p{Lu})/u);
}

/**
 * A quiet line after a main chapter: something the reader can now explain, and the question the next chapter takes up.
 * Turned off in the Aa menu, and left out where the preset has nothing true to say.
 */
export function ChapterClosing({ bookId, chapterId, chapters, blocks, notes, highlights, lang }: Props) {
  const { chapterNotes } = usePrefs();
  const preset = useMemo(
    () => (chapterNotes ? closingPreset({ chapters, chapterId, marks: closingMarks(blocks, notes, highlights) }) : null),
    [chapterNotes, chapters, chapterId, blocks, notes, highlights],
  );
  return preset === null ? null : <ClosingLine bookId={bookId} chapterId={chapterId} lang={lang} preset={preset} />;
}

/**
 * The line itself. The preset is on the page from the start, unseen, so the block takes its room before the reader
 * arrives and turning pages measures it. The helper's line replaces it only while the block is still below the
 * window; once the reader gets there, the text they see is the text that stays.
 */
function ClosingLine({ bookId, chapterId, lang, preset }: { bookId: string; chapterId: string; lang: LangCode; preset: string }) {
  const ref = useRef<HTMLElement>(null);
  const status = useAiStatus();
  // Null until it is known whether this reader has a helper.
  const helper = status === null ? null : status.active !== null;
  const [near, setNear] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const text = seen ?? answer ?? preset;
  const show = useEffectEvent(() => setSeen((kept) => kept ?? text));

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const nearby = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setNear(true);
        nearby.disconnect();
      },
      { rootMargin: NEAR },
    );
    const inView = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      show();
      inView.disconnect();
    });
    nearby.observe(element);
    inView.observe(element);
    return () => {
      nearby.disconnect();
      inView.disconnect();
    };
  }, []);

  // Asked once the reader is near and has a helper. Still answered after the reader has seen the preset: the server
  // keeps the line for their next visit.
  const answered = answer !== null;
  useEffect(() => {
    if (!near || helper !== true || answered) return;
    const controller = new AbortController();
    api
      .chapterClosing(bookId, chapterId, lang, controller.signal)
      .then((line) => {
        // On screen already, or passed by a jump the observer never saw: what is there stays.
        if ((ref.current?.getBoundingClientRect().top ?? Infinity) < window.innerHeight) show();
        setAnswer(line);
      })
      // Whatever went wrong, the preset is already in place.
      .catch(() => {});
    return () => controller.abort();
  }, [near, helper, answered, bookId, chapterId, lang]);

  return (
    <aside ref={ref} className="closing" aria-label="After this chapter" data-shown={seen !== null || undefined}>
      <p>
        {sentencesOf(text).map((sentence, at) => (
          <span key={at} className="closing-sentence">
            {sentence}
          </span>
        ))}
      </p>
    </aside>
  );
}
