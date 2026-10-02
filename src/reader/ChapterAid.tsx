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

const COPY = {
  preview: {
    title: "Before you read",
    prompt: "Get a short, simple preview of this chapter and its hard words.",
    action: "Preview this chapter",
    waiting: "Reading the chapter for you...",
  },
  recap: {
    title: "What you just read",
    prompt: "Finished? Get the key ideas of this chapter in simple words.",
    action: "Summarize this chapter",
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
    <section className="aid" aria-label={copy.title}>
      <h3 className="aid-title">{copy.title}</h3>
      {!open ? (
        <div className="aid-closed">
          <p>{copy.prompt}</p>
          <button type="button" className="button" onClick={() => setAskedIn(lang)}>
            {copy.action}
          </button>
        </div>
      ) : (
        <div aria-live="polite">
          {answer.text ? <RichText text={answer.text} /> : answer.status === "loading" && <p className="aid-wait">{copy.waiting}</p>}
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
