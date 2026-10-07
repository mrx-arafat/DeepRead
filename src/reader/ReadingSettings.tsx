import { AlignJustify, AlignLeft, ArrowLeft, AudioWaveform, BookOpen, Monitor, ScrollText, Settings, X } from "lucide-react";
import { useEffect, useState, type FocusEvent, type ReactNode, type ToggleEvent } from "react";
import { LANGUAGES, type AiProviderId, type AiStatus, type LangCode } from "../../shared/types.ts";
import { api } from "../api.ts";
import { FONT_SIZES, setPrefs, type Prefs } from "../prefs.ts";
import { useSession } from "../profiles/session.tsx";
import { setAiStatus, useReaderKey } from "./aiStatusStore.ts";
import { helperRows } from "./helperState.ts";
import type { Viewer } from "./helperState.ts";
import { NATURAL_DOWNLOAD_MB, useNaturalState } from "./natural.ts";
import { keepingPlace } from "./useChapterTranslation.ts";
import { keepingLine } from "./useReadingPosition.ts";

const PANEL = "reading-settings";

type Option<T extends string> = { value: T; label: string; content: ReactNode };

/** One choice out of a few, shown side by side; `iconOnly` keeps the label for screen readers and the tooltip. */
function Choice<T extends string>(props: {
  name: string;
  legend: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <fieldset className="settings-group">
      <legend className="settings-label">{props.legend}</legend>
      <div className={`segmented ${props.className ?? ""}`}>
        {props.options.map((option) => (
          <label key={option.value} title={props.iconOnly ? option.label : undefined}>
            <input
              type="radio"
              name={`${PANEL}-${props.name}`}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            {option.content}
            {props.iconOnly ? <span className="visually-hidden">{option.label}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Three lines as far apart as the line spacing they stand for. */
function SpacingIcon({ gap }: { gap: number }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      {[-gap, 0, gap].map((dy) => (
        <path key={dy} d={`M5 ${12 + dy}h14`} />
      ))}
    </svg>
  );
}

/** A page with its lines as wide as the margins leave them. */
function MarginsIcon({ inset }: { inset: number }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      {[8.5, 12, 15.5].map((y) => (
        <path key={y} d={`M${3 + inset} ${y}H${21 - inset}`} />
      ))}
    </svg>
  );
}

const THEME_OPTIONS: Option<Prefs["theme"]>[] = [
  { value: "light", label: "Light", content: <Swatch label="Light" /> },
  { value: "sepia", label: "Sepia", content: <Swatch label="Sepia" /> },
  { value: "dark", label: "Dark", content: <Swatch label="Dark" /> },
];

/** The page as it would look: its paper, and "Aa" in its ink. */
function Swatch({ label }: { label: string }) {
  return (
    <>
      <span className="swatch-page" aria-hidden>
        Aa
      </span>
      {label}
    </>
  );
}

const FONT_OPTIONS: Option<Prefs["font"]>[] = [
  { value: "serif", label: "Literata", content: <span className="font-sample font-sample-serif">Literata</span> },
  { value: "sans", label: "Atkinson", content: <span className="font-sample font-sample-sans">Atkinson</span> },
];

const SPACING_OPTIONS: Option<Prefs["spacing"]>[] = [
  { value: "tight", label: "Tight line spacing", content: <SpacingIcon gap={3.5} /> },
  { value: "normal", label: "Normal line spacing", content: <SpacingIcon gap={5} /> },
  { value: "loose", label: "Loose line spacing", content: <SpacingIcon gap={6.5} /> },
];

const MARGIN_OPTIONS: Option<Prefs["margins"]>[] = [
  { value: "narrow", label: "Narrow margins", content: <MarginsIcon inset={2.5} /> },
  { value: "normal", label: "Normal margins", content: <MarginsIcon inset={4.5} /> },
  { value: "wide", label: "Wide margins", content: <MarginsIcon inset={6} /> },
];

const ALIGN_OPTIONS: Option<Prefs["align"]>[] = [
  { value: "left", label: "Align left", content: <AlignLeft size={20} aria-hidden /> },
  { value: "justify", label: "Justify", content: <AlignJustify size={20} aria-hidden /> },
];

const LAYOUT_OPTIONS: Option<Prefs["layout"]>[] = [
  {
    value: "scroll",
    label: "Scroll",
    content: (
      <>
        <ScrollText size={18} aria-hidden /> Scroll
      </>
    ),
  },
  {
    value: "pages",
    label: "Pages",
    content: (
      <>
        <BookOpen size={18} aria-hidden /> Pages
      </>
    ),
  },
];

const VOICE_OPTIONS: Option<Prefs["voice"]>[] = [
  {
    value: "device",
    label: "This device",
    content: (
      <>
        <Monitor size={18} aria-hidden /> This device
      </>
    ),
  },
  {
    value: "natural",
    label: "Natural",
    content: (
      <>
        <AudioWaveform size={18} aria-hidden /> Natural
      </>
    ),
  },
];

/** Who reads aloud, and what the natural voice is doing about it: it is downloaded once, and may not suit this computer. */
function VoiceChoice({ voice }: { voice: Prefs["voice"] }) {
  const natural = useNaturalState();
  const percent = Math.round(natural.progress * 100);
  const hint =
    voice === "device"
      ? `The voice built into this computer. Natural is a more human voice that runs on this computer and works offline once it has downloaded (${NATURAL_DOWNLOAD_MB} MB, once).`
      : natural.status === "ready"
        ? "The natural voice runs on this computer and works offline."
        : natural.status === "downloading"
          ? `Downloading the natural voice: ${percent}%. This device's voice reads until it is ready.`
          : natural.message
            ? natural.message
            : "Getting the natural voice ready...";
  return (
    <div className="settings-group">
      <Choice name="voice" legend="Read-aloud voice" value={voice} options={VOICE_OPTIONS} onChange={(value) => setPrefs({ voice: value })} />
      <p className="settings-hint" aria-live="polite">
        {hint}
      </p>
    </div>
  );
}

/** A change that reflows the book, made so the line being read stays where it is on screen. */
const reflow = (patch: Partial<Prefs>) => keepingLine(() => setPrefs(patch));

/** Tabbing past a panel closes it, except when returning to its trigger. */
function closeWhenTabbedAway(event: FocusEvent<HTMLElement>) {
  const next = event.relatedTarget;
  if (next && !event.currentTarget.contains(next) && next.getAttribute("popovertarget") !== event.currentTarget.id) {
    event.currentTarget.hidePopover();
  }
}

const SETUP_HELP = "https://github.com/mrx-arafat/DeepRead#ai-helpers";

/**
 * Which AI helper explains words and passages, with every helper shown in the state it is in for this reader: theirs to
 * pick, installed but the admin's to give (with a way to ask), or not there at all. Looked up each time the menu opens: one
 * may have been installed, or given, since. The server decides who may use what; this only shows it.
 */
function AiHelper({ open, viewer }: { open: boolean; viewer: Viewer }) {
  const reader = useReaderKey();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<AiProviderId | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .aiStatus()
      .then((found) => {
        if (cancelled) return;
        setStatus(found);
        setAiStatus(found, reader);
        setError(null);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [open, reader]);

  async function change(work: () => Promise<AiStatus>) {
    try {
      const next = await work();
      setStatus(next);
      // The selection bar names whose helper answers: it follows a pick at once.
      setAiStatus(next, reader);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function ask(id: AiProviderId) {
    setAsking(id);
    await change(() => api.requestAi(id));
    setAsking(null);
  }

  const rows = status ? helperRows(status, viewer) : [];
  const active = status?.providers.find((provider) => provider.id === status.active);
  const detail = active?.detail ? ` (${active.detail})` : "";
  return (
    <fieldset className="settings-group">
      <legend className="settings-label">AI helper</legend>
      {viewer === "reader" && <p className="settings-hint helper-lead">{status?.owner ?? "The admin"} decides which of these you can use.</p>}
      {status && (
        <ul className="helper-list">
          {rows.map((row) => {
            const usable = row.state === "selected" || row.state === "available";
            return (
              <li key={row.id} className="helper" data-state={row.state}>
                <label className="helper-pick">
                  <input
                    type="radio"
                    name={`${PANEL}-ai`}
                    value={row.id}
                    checked={row.state === "selected"}
                    disabled={!usable}
                    aria-describedby={`${PANEL}-ai-${row.id}`}
                    onChange={() => void change(() => api.chooseAi(row.id))}
                  />
                  <span className="helper-name">{row.name}</span>
                  <span id={`${PANEL}-ai-${row.id}`} className="helper-note">
                    {row.note ?? row.help}
                  </span>
                </label>
                {row.state === "ask" && (
                  <button type="button" className="quiet-button helper-ask" disabled={asking !== null} onClick={() => void ask(row.id)}>
                    {asking === row.id ? "Asking..." : `Ask ${status?.owner ?? "the admin"}`}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="settings-hint" aria-live="polite">
        {error ? (
          <span className="inline-error">{error}</span>
        ) : !status ? (
          "Looking for AI helpers..."
        ) : active ? (
          viewer === "reader"
            ? status?.owner
              ? `You are using ${status.owner}'s ${active.name}. Sharing is caring.`
              : `${active.name}${detail} answers for you.`
            : `${active.name}${detail} explains words and passages.`
        ) : viewer === "reader" ? (
          rows.some((row) => row.state === "ask")
            ? `You have no AI helper yet. Ask ${status?.owner ?? "the admin"} for one above. Reading and listening work without one.`
            : rows.some((row) => row.state === "asked")
              ? `Asked. ${status?.owner ?? "The admin"} will see it. Reading and listening work meanwhile.`
              : "No AI helper is set up on this server yet. Reading and listening work without one."
        ) : (
          <>
            None yet. Install Claude Code or Codex, or set up an API model; reading and listening work without one.{" "}
            <a href={SETUP_HELP} target="_blank" rel="noreferrer">
              How to set one up
            </a>
          </>
        )}
      </p>
    </fieldset>
  );
}

/**
 * Each paragraph in the reader's language under the English. The admin may turn it off for readers, and then a reader
 * sees it greyed out, with why. Translations come and go with the paragraph the reader is on held still on screen.
 */
function TranslationSwitch({ prefs, blocked }: { prefs: Prefs; blocked: boolean }) {
  return (
    <div className="settings-group settings-switch settings-translation">
      <label className="settings-label" htmlFor={`${PANEL}-translation`}>
        Translation
      </label>
      <button
        id={`${PANEL}-translation`}
        type="button"
        role="switch"
        className="switch"
        aria-checked={prefs.translation && !blocked}
        aria-describedby={`${PANEL}-translation-hint`}
        disabled={blocked}
        onClick={() => keepingPlace(() => setPrefs({ translation: !prefs.translation }))}
      >
        <span className="switch-track" aria-hidden />
      </button>
      <p id={`${PANEL}-translation-hint`} className="settings-hint">
        {blocked ? "The admin has turned translation off." : `Show each paragraph in ${LANGUAGES[prefs.lang]} under it.`}
      </p>
    </div>
  );
}

/**
 * Appearance, reader preferences and voice setup use separate native popovers.
 * The same saved preferences and reflow path apply whichever panel holds a control.
 * `readersTranslate` is whether the admin lets readers show translations, null until known.
 */
export function ReadingSettings({ prefs, readersTranslate }: { prefs: Prefs; readersTranslate: boolean | null }) {
  const [open, setOpen] = useState(false);
  const { info } = useSession();
  // With profiles, the admin's own profile sees every helper as theirs; a reader sees which the admin has given them.
  const viewer: Viewer = info?.mode === "profiles" ? (info.session?.admin && !info.session.impersonatedBy ? "admin" : "reader") : "single";
  // As the server has it: the admin may always translate, viewing as someone else too, and without profiles anyone may.
  const translationBlocked = readersTranslate === false && info?.mode === "profiles" && !info.session?.admin;
  return (
    <>
      <button type="button" className="icon-button settings-button" popoverTarget={PANEL} aria-label="Reading settings">
        Aa
      </button>
      <section
        id={PANEL}
        popover="auto"
        className="popover settings"
        aria-label="Reading settings"
        onBlur={closeWhenTabbedAway}
      >
        <Choice
          name="theme"
          legend="Theme"
          value={prefs.theme}
          options={THEME_OPTIONS}
          onChange={(theme) => setPrefs({ theme })}
          className="swatches"
        />

        <Choice name="font" legend="Font" value={prefs.font} options={FONT_OPTIONS} onChange={(font) => reflow({ font })} />

        <div className="settings-group" role="group" aria-labelledby={`${PANEL}-size`}>
          <p id={`${PANEL}-size`} className="settings-label">
            Text size
          </p>
          <div className="size-row">
            <button
              type="button"
              className="text-size"
              aria-label="Smaller text"
              disabled={prefs.fontSize <= FONT_SIZES.min}
              onClick={() => reflow({ fontSize: prefs.fontSize - 1 })}
            >
              A
            </button>
            <input
              type="range"
              className="size-slider"
              aria-label="Text size"
              min={FONT_SIZES.min}
              max={FONT_SIZES.max}
              value={prefs.fontSize}
              onChange={(event) => reflow({ fontSize: Number(event.target.value) })}
            />
            <button
              type="button"
              className="text-size text-size-large"
              aria-label="Larger text"
              disabled={prefs.fontSize >= FONT_SIZES.max}
              onClick={() => reflow({ fontSize: prefs.fontSize + 1 })}
            >
              A
            </button>
          </div>
        </div>

        <div className="settings-pair">
          <Choice
            name="spacing"
            legend="Line spacing"
            value={prefs.spacing}
            options={SPACING_OPTIONS}
            onChange={(spacing) => reflow({ spacing })}
            iconOnly
          />
          <Choice
            name="margins"
            legend="Margins"
            value={prefs.margins}
            options={MARGIN_OPTIONS}
            onChange={(margins) => reflow({ margins })}
            iconOnly
          />
        </div>

        <Choice
          name="align"
          legend="Alignment"
          value={prefs.align}
          options={ALIGN_OPTIONS}
          onChange={(align) => reflow({ align })}
          iconOnly
        />

        <Choice name="layout" legend="Layout" value={prefs.layout} options={LAYOUT_OPTIONS} onChange={(layout) => reflow({ layout })} />

        <TranslationSwitch prefs={prefs} blocked={translationBlocked} />

        <button type="button" className="quiet-button settings-next" aria-label="Reader preferences" onClick={() => switchPanel(PANEL, "reader-preferences")}>
          <Settings size={18} aria-hidden /> Reader preferences
        </button>
      </section>

      <section
        id="reader-preferences"
        popover="auto"
        className="popover settings"
        aria-label="Reader preferences"
        onBlur={closeWhenTabbedAway}
        onToggle={(event: ToggleEvent<HTMLElement>) => {
          setOpen(event.newState === "open");
          returnFocus(event);
        }}
      >
        <PanelHeading title="Reader preferences" back={PANEL} />

        {/* The label is tied to the switch, so a tap on the words turns it too. */}
        <div className="settings-group settings-switch">
          <label className="settings-label" htmlFor={`${PANEL}-chapter-notes`}>
            End-of-chapter notes
          </label>
          <button
            id={`${PANEL}-chapter-notes`}
            type="button"
            role="switch"
            className="switch"
            aria-checked={prefs.chapterNotes}
            aria-describedby={`${PANEL}-chapter-notes-hint`}
            onClick={() => reflow({ chapterNotes: !prefs.chapterNotes })}
          >
            <span className="switch-track" aria-hidden />
          </button>
          <p id={`${PANEL}-chapter-notes-hint`} className="settings-hint">
            A short line after each chapter about what you just read.
          </p>
        </div>

        <hr className="settings-divider" />

        <div className="settings-group">
          <label className="settings-label" htmlFor={`${PANEL}-lang`}>
            Explain in
          </label>
          <select
            id={`${PANEL}-lang`}
            value={prefs.lang}
            aria-describedby={`${PANEL}-lang-hint`}
            // With translation on, the chapters are asked for again in the new language: the reader's place holds meanwhile.
            onChange={(event) => keepingPlace(() => setPrefs({ lang: event.target.value as LangCode }))}
          >
            {Object.entries(LANGUAGES).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          {/* Says what the choice changes, and changes with it, so the reader sees it took effect. */}
          <p id={`${PANEL}-lang-hint`} className="settings-hint">
            Word meanings, explanations and translations come in {LANGUAGES[prefs.lang]}. The book itself stays in English.
          </p>
        </div>

        <button type="button" className="quiet-button settings-next" aria-label="Voice settings" onClick={() => switchPanel("reader-preferences", "reading-voice")}>
          <AudioWaveform size={18} aria-hidden /> Voice settings
        </button>

        <AiHelper open={open} viewer={viewer} />
      </section>

      <section id="reading-voice" popover="auto" className="popover settings voice-settings" aria-label="Voice settings" onBlur={closeWhenTabbedAway} onToggle={returnFocus}>
        <PanelHeading title="Voice settings" back="reader-preferences" />
        <VoiceChoice voice={prefs.voice} />
      </section>
    </>
  );
}

/** Replace a panel without nesting popovers or moving the book underneath. */
function switchPanel(from: string, to: string): void {
  document.getElementById(from)?.hidePopover();
  const next = document.getElementById(to);
  next?.showPopover();
  next?.querySelector<HTMLElement>("button, input, select")?.focus({ preventScroll: true });
}

/** A replaced panel has no visible trigger; return to Aa when dismissal leaves focus hidden. */
function returnFocus(event: ToggleEvent<HTMLElement>): void {
  if (event.newState !== "closed") return;
  const focus = document.activeElement;
  if (focus === document.body || (focus instanceof Element && focus.closest("[popover]") && !focus.closest(":popover-open"))) {
    document.querySelector<HTMLButtonElement>(".settings-button")?.focus({ preventScroll: true });
  }
}

function PanelHeading({ title, back }: { title: string; back: string }) {
  return (
    <header className="settings-heading">
      <button type="button" className="icon-button" aria-label={back === PANEL ? "Back to appearance" : "Back to reader preferences"} onClick={(event) => switchPanel(event.currentTarget.closest("[popover]")!.id, back)}>
        <ArrowLeft size={18} aria-hidden />
      </button>
      <h2>{title}</h2>
      <button type="button" className="icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={(event) => event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover()}>
        <X size={18} aria-hidden />
      </button>
    </header>
  );
}
