import { useState } from "react";
import type { ChapterAidRequest, LangCode } from "../../shared/types.ts";
import { RichText } from "./RichText.tsx";
import { useAiStream } from "./useAiStream.ts";

type Props = {
  kind: "preview" | "recap";
  bookId: string;
  chapterId: string;
  lang: LangCode;
};

// The actions are short so that, before it is asked for, each aid fits on one line beside its title, even on a phone.
const COPY = {
  preview: {
    title: "Before you read",
    action: "Get a preview",
    waiting: "Reading the chapter for you...",
  },
  recap: {
    title: "What you just read",
    action: "Get a summary",
    waiting: "Writing your summary...",
  },
} as const;

/** The chapter companion: a preview before reading, a summary after. Generated only when asked for. */
export function ChapterAid({ kind, bookId, chapterId, lang }: Props) {
  // Asked in the language picked when the reader opened it: picking another one later must not ask again.
  const [askedIn, setAskedIn] = useState<LangCode | null>(null);
  const open = askedIn !== null;
  const request: ChapterAidRequest = { bookId, chapterId, kind, lang: askedIn ?? lang };
  const answer = useAiStream("/api/ai/chapter", request, open);
  const copy = COPY[kind];

  return (
    <section className="aid" aria-label={copy.title} data-closed={!open || undefined}>
      <h3 className="aid-title">{copy.title}</h3>
      {!open ? (
        <button type="button" className="quiet-button aid-ask" onClick={() => setAskedIn(lang)}>
          {copy.action}
        </button>
      ) : (
        <div aria-live="polite" aria-busy={answer.status === "loading"}>
          {answer.text ? (
            <RichText text={answer.text} writing={answer.status === "loading"} />
          ) : (
            answer.status === "loading" && <p className="aid-wait">{copy.waiting}</p>
          )}
          {answer.status === "error" && (
            <p className="inline-error">
              {answer.error}{" "}
              <button type="button" className="link-button" onClick={answer.retry}>
                Try again
              </button>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
