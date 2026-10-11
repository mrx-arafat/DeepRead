import { ArrowRight, Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "wouter";
import { formatBytes } from "../../shared/bytes.ts";
import type { BookSummary } from "../../shared/types.ts";
import { BookTitle } from "./BookTitle.tsx";
import { countdownLeft, holdCountdown, releaseCountdown, startCountdown } from "./countdown.ts";
import type { Countdown } from "./countdown.ts";
import { Cover } from "./Cover.tsx";

/** Sending the file, then DeepRead reading its pages, then the finished book waiting to be opened. */
export type UploadPhase = "sending" | "reading" | "ready";

export interface UploadState {
  fileName: string;
  /** The file's size, which the reader knows it by; the request is a little larger. */
  size: number;
  /** 0 to 1: how much of the request the browser has sent. */
  sent: number;
  phase: UploadPhase;
  startedAt: number;
  /** When DeepRead answered with the finished book: the clock stops there. */
  readyAt: number | null;
  /** The book DeepRead made of the file, once it has answered. */
  book: Pick<BookSummary, "id" | "title" | "author" | "hasCover"> | null;
}

type StepState = "waiting" | "active" | "done";

/** After this long reading, the panel says a long book takes a while, so the wait does not look stuck. */
const SLOW_READ_MS = 10_000;
/** How long the finished book waits before it opens by itself: time to see it, and to choose to stay. */
const AUTO_OPEN_MS = 4000;

const STEPS: { label: string; state: Record<UploadPhase, StepState> }[] = [
  { label: "Upload", state: { sending: "active", reading: "done", ready: "done" } },
  { label: "Read", state: { sending: "waiting", reading: "active", ready: "done" } },
  { label: "Open", state: { sending: "waiting", reading: "waiting", ready: "done" } },
];

/** "Mastering_Mind_Games.pdf" reads as "Mastering Mind Games": the title the book goes by until DeepRead finds its own. */
export function titleFromFileName(fileName: string): string {
  const title = fileName.replace(/\.pdf$/i, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return title || fileName;
}

/** "0:07", "1:42": how long the book has been on its way. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A sentence for each phase only, so a screen reader hears the book move along, not every percent or second. */
function phaseSentence(phase: UploadPhase, slow: boolean, stayed: boolean): string {
  if (phase === "sending") return "Uploading your PDF.";
  if (phase === "ready") return stayed ? "On your shelf. Open it whenever you like." : `Added. Opening it in ${AUTO_OPEN_MS / 1000} seconds.`;
  return slow ? "Still reading. A long book can take a minute." : "Finding the chapters, pages, and cover.";
}

interface UploadPanelProps {
  upload: UploadState;
  onCancel: () => void;
  /** The countdown ran out: open the book. */
  onOpen: (bookId: string) => void;
  /** Put the finished card away, leaving the book on the shelf. */
  onClose: () => void;
}

/**
 * A book on its way into the library: its cloth fills from the bottom as the file uploads, catches the light while
 * DeepRead reads it, and turns to face the reader in its own cover. Then it waits a few seconds with an Open button
 * before opening by itself, unless the reader chooses to stay, or is pointing at the card or tabbing through it.
 */
export function UploadPanel({ upload, onCancel, onOpen, onClose }: UploadPanelProps) {
  const { phase, sent, book } = upload;
  const ready = phase === "ready" && book !== null;
  const [now, setNow] = useState(() => Date.now());
  // When DeepRead started reading: a slow upload is not a slow read, so "Still reading" counts from here.
  const [readingAt, setReadingAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [stayed, setStayed] = useState(false);
  const [pointed, setPointed] = useState(false);
  const [tabbedIn, setTabbedIn] = useState(false);
  const held = pointed || tabbedIn;
  const card = useRef<HTMLElement>(null);
  const openLink = useRef<HTMLAnchorElement>(null);
  const opened = useRef(false);

  const left = ready && !stayed && countdown ? countdownLeft(countdown, now) : null;
  const counting = left !== null;
  const due = left === 0;

  useEffect(() => {
    if (phase === "reading") setReadingAt(Date.now());
    if (phase !== "ready") return;
    // One moment for both, so the first "Opening in" is counted from the countdown's own start, not the last tick.
    const at = Date.now();
    setNow(at);
    // A pointer already resting on the card holds the countdown from its first moment.
    setCountdown(startCountdown(AUTO_OPEN_MS, at, card.current?.matches(":hover") ?? false));
    // The reader who started the upload from the Add button, or whose focus fell to the page when it went, is
    // taken to the Open button. Moved from a mouse click, focus does not match :focus-visible, so it does not hold
    // the countdown (see onFocus below); moved from the keyboard, it does, and Enter opens the book.
    const active = document.activeElement;
    if (active === document.body || active?.closest(".drop")) openLink.current?.focus();
  }, [phase]);

  useEffect(() => {
    setCountdown((current) => current && (held ? holdCountdown(current, Date.now()) : releaseCountdown(current, Date.now())));
  }, [held]);

  // Once a second for the clock while the book is on its way, four times a second for the countdown.
  useEffect(() => {
    if (phase === "ready" && !counting) return;
    const timer = setInterval(() => setNow(Date.now()), counting ? 250 : 1000);
    return () => clearInterval(timer);
  }, [phase, counting]);

  useEffect(() => {
    if (!due || !book || opened.current) return;
    opened.current = true;
    onOpen(book.id);
  }, [due, book, onOpen]);

  function stay() {
    setStayed(true);
    // The Stay here button is about to go: focus stays in the card, on the one thing left to do.
    openLink.current?.focus();
  }

  const elapsed = (upload.readyAt ?? now) - upload.startedAt;
  const percent = Math.min(100, Math.floor(sent * 100));
  const title = book?.title ?? titleFromFileName(upload.fileName);
  const cover = book ?? { id: `upload:${upload.fileName}`, title, author: null, hasCover: false };
  // The upload's bar follows the bytes; the others are full once their step is done (Read sweeps while it is under way).
  const fill = (step: number, state: StepState): number => (step === 0 && phase === "sending" ? sent : state === "done" ? 1 : 0);
  const secondsLeft = left === null ? 0 : Math.max(1, Math.ceil(left / 1000));

  return (
    <section
      ref={card}
      className="upload-panel"
      data-phase={phase}
      data-held={(counting && held) || undefined}
      data-stayed={stayed || undefined}
      aria-labelledby="upload-panel-title"
      style={{ "--auto-open": `${AUTO_OPEN_MS}ms` } as CSSProperties}
      onPointerEnter={(event) => event.pointerType === "mouse" && setPointed(true)}
      onPointerLeave={() => setPointed(false)}
      // Only keyboard focus holds the countdown: focus a mouse click leaves behind is not the reader reading the card.
      onFocus={(event) => setTabbedIn(event.target.matches(":focus-visible"))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setTabbedIn(false);
      }}
    >
      <div className="upload-book" style={{ "--sent": phase === "sending" ? sent : 1 } as CSSProperties} aria-hidden>
        <span className="upload-book-board">
          <span className="upload-book-ghost" />
          <Cover book={cover} />
          <span className="upload-book-sheen" />
        </span>
        <span className="upload-book-done">
          <Check size={14} strokeWidth={3} />
        </span>
      </div>

      <div className="upload-body">
        <p className="upload-kicker">
          <span className="upload-pulse" aria-hidden />
          {ready ? "Added to your library" : "Adding to your library"}
        </p>
        <h2 id="upload-panel-title" className="upload-title">
          <BookTitle title={title} />
        </h2>
        <p className="upload-meta">
          {book?.author && (
            <>
              by {book.author}
              <span aria-hidden> · </span>
            </>
          )}
          {formatBytes(upload.size)} PDF
          <span aria-hidden> · </span>
          <span className="upload-clock">{clock(elapsed)}</span>
        </p>

        {ready && book ? (
          <div className="upload-actions">
            <Link ref={openLink} href={`/book/${book.id}`} className="button upload-open">
              Open book <ArrowRight size={18} aria-hidden />
            </Link>
            {!stayed && (
              <>
                <button type="button" className="quiet-button" onClick={stay}>
                  Stay here
                </button>
                <span className="upload-countdown" aria-hidden>
                  {held ? "Paused" : `Opening in ${secondsLeft} s`}
                </span>
              </>
            )}
          </div>
        ) : (
          <ol className="upload-steps">
            {STEPS.map((step, index) => {
              const state = step.state[phase];
              return (
                <li key={step.label} className="upload-step" data-state={state}>
                  <span
                    className="upload-track"
                    style={{ "--fill": fill(index, state) } as CSSProperties}
                    {...(index === 0
                      ? { role: "progressbar", "aria-label": "Upload", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": phase === "sending" ? percent : 100 }
                      : {})}
                  >
                    <span className="upload-fill" />
                  </span>
                  <span className="upload-step-label">
                    <span className="upload-step-name">
                      {state === "done" && <Check size={12} strokeWidth={3} aria-hidden />}
                      {step.label}
                    </span>
                    {index === 0 && phase === "sending" && <span className="upload-percent">{percent}%</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {/* While the countdown shows beside the buttons, the same news is only said, not shown twice. */}
        <p className={ready && !stayed ? "upload-status visually-hidden" : "upload-status"} role="status">
          {phaseSentence(phase, readingAt !== null && now - readingAt > SLOW_READ_MS, stayed)}
        </p>
      </div>

      {phase === "sending" && (
        <button type="button" className="quiet-button upload-cancel" onClick={onCancel}>
          <X size={16} aria-hidden /> Cancel
        </button>
      )}
      {ready && (
        <button type="button" className="icon-button upload-close" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      )}
    </section>
  );
}
