import { ChevronDown, ChevronUp } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
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
    reopen: "Show preview",
    waiting: "Reading the chapter for you...",
  },
  recap: {
    title: "What you just read",
    action: "Get a summary",
    reopen: "Show summary",
    waiting: "Writing your summary...",
  },
} as const;

/** The chapter companion: a preview before reading, a summary after. Generated only when asked for. */
export function ChapterAid({ kind, bookId, chapterId, lang }: Props) {
  // Asked in the language picked when the reader opened it: picking another one later must not ask again.
  const [askedIn, setAskedIn] = useState<LangCode | null>(null);
  const [expanded, setExpanded] = useState(false);
  const open = expanded && askedIn !== null;
  const request: ChapterAidRequest = { bookId, chapterId, kind, lang: askedIn ?? lang };
  const answer = useAiStream("/api/ai/chapter", request, askedIn !== null);
  const copy = COPY[kind];
  const panelRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const setPanelHeight = () => {
      const top = panel.getBoundingClientRect().top;
      const footerTop = document.querySelector(".reading-footer")?.getBoundingClientRect().top ?? window.innerHeight;
      const bottom = Math.min(window.innerHeight, footerTop) - 12;
      panel.style.setProperty("--panel-max", `${Math.max(48, bottom - top)}px`);
    };
    setPanelHeight();
    window.addEventListener("resize", setPanelHeight);
    window.addEventListener("scroll", setPanelHeight, { passive: true });
    return () => {
      window.removeEventListener("resize", setPanelHeight);
      window.removeEventListener("scroll", setPanelHeight);
    };
  }, [open]);

  return (
    <section ref={panelRef} className="aid" aria-label={copy.title} data-closed={!open || undefined}>
      <header className="aid-head">
        <h3 className="aid-title">{copy.title}</h3>
        {!open ? (
          <button
            type="button"
            className="quiet-button aid-ask"
            aria-expanded={false}
            onClick={() => {
              setAskedIn((value) => value ?? lang);
              setExpanded(true);
            }}
          >
            <span>{askedIn === null ? copy.action : copy.reopen}</span>
            <ChevronDown size={16} aria-hidden />
          </button>
        ) : (
          <button type="button" className="icon-button aid-toggle" aria-label={`Hide ${copy.title}`} aria-expanded={true} onClick={() => setExpanded(false)}>
            <ChevronUp size={16} aria-hidden />
          </button>
        )}
      </header>
      {!open ? (
        null
      ) : (
        <div className="aid-body" aria-live="polite" aria-busy={answer.status === "loading"}>
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
