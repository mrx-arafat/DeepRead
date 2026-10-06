import { AlignJustify, AlignLeft, AudioWaveform, BookOpen, Monitor, ScrollText } from "lucide-react";
import { useEffect, useState, type FocusEvent, type ReactNode, type ToggleEvent } from "react";
import { LANGUAGES, type AiProviderId, type AiStatus, type LangCode } from "../../shared/types.ts";
import { api } from "../api.ts";
import { FONT_SIZES, setPrefs, type Prefs } from "../prefs.ts";
import { useSession } from "../profiles/session.tsx";
import { NATURAL_DOWNLOAD_MB, useNaturalState } from "./natural.ts";
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

/** Tabbing on past the last control closes the menu, as a tap outside does; going back to the "Aa" button keeps it. */
function closeWhenTabbedAway(event: FocusEvent<HTMLElement>) {
  const next = event.relatedTarget;
  if (next && !event.currentTarget.contains(next) && next.getAttribute("popovertarget") !== PANEL) {
    event.currentTarget.hidePopover();
  }
}

const SETUP_HELP = "https://github.com/mrx-arafat/DeepRead#ai-helpers";

/**
 * Which AI tool explains words and passages. Looked up each time the menu opens: one may have been installed since.
 * It is one tool for everyone, so with profiles only the admin can change it; the others are told which one it is.
 */
function AiHelper({ open, canChoose }: { open: boolean; canChoose: boolean }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .aiStatus()
      .then((found) => {
        if (cancelled) return;
        setStatus(found);
        setError(null);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function choose(id: AiProviderId) {
    try {
      setStatus(await api.chooseAi(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const active = status?.providers.find((provider) => provider.id === status.active);
  const choosing = canChoose && active && status;
  return (
    <div className="settings-group">
      {choosing ? (
        <label className="settings-label" htmlFor={`${PANEL}-ai`}>
          AI helper
        </label>
      ) : (
        <p className="settings-label">AI helper</p>
      )}
      {choosing && (
        <select
          id={`${PANEL}-ai`}
          value={active.id}
          aria-describedby={`${PANEL}-ai-hint`}
          onChange={(event) => void choose(event.target.value as AiProviderId)}
        >
          {status.providers.map((provider) => (
            <option key={provider.id} value={provider.id} disabled={!provider.installed}>
              {provider.installed ? provider.name : `${provider.name} (not installed)`}
            </option>
          ))}
        </select>
      )}
      <p id={`${PANEL}-ai-hint`} className="settings-hint" aria-live="polite">
        {error ? (
          <span className="inline-error">{error}</span>
        ) : !status ? (
          "Looking for AI helpers on this computer..."
        ) : active ? (
          canChoose
            ? `${active.name} explains words and passages, signed in with your own account.`
            : `${active.name} explains words and passages. Only the admin can change it.`
        ) : canChoose ? (
          <>
            None found. Install Claude Code or Codex and sign in to get explanations; reading and listening work without one.{" "}
            <a href={SETUP_HELP} target="_blank" rel="noreferrer">
              How to set one up
            </a>
          </>
        ) : (
          "No AI helper is set up, so there are no explanations. Ask the admin to set one up; reading and listening work without one."
        )}
      </p>
    </div>
  );
}

/**
 * The "Aa" menu at the end of the top bar, laid out like an e-reader's: the page colour, the book's font, text size,
 * line spacing, margins, alignment and whether the book scrolls or turns pages, then the language explanations
 * come in and the AI tool that writes them.
 * A native popover, so a tap outside or Escape closes it and focus goes back to the button, on every screen size.
 */
export function ReadingSettings({ prefs }: { prefs: Prefs }) {
  const [open, setOpen] = useState(false);
  const { info } = useSession();
  // The server refuses the change to anyone else, so the choice is only offered where it can be made.
  const canChooseAi = info?.mode === "single" || (info?.mode === "profiles" && info.session?.admin === true);
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
        onToggle={(event: ToggleEvent<HTMLElement>) => setOpen(event.newState === "open")}
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

        <hr className="settings-divider" />

        <VoiceChoice voice={prefs.voice} />

        <div className="settings-group">
          <label className="settings-label" htmlFor={`${PANEL}-lang`}>
            Explain in
          </label>
          <select
            id={`${PANEL}-lang`}
            value={prefs.lang}
            aria-describedby={`${PANEL}-lang-hint`}
            onChange={(event) => setPrefs({ lang: event.target.value as LangCode })}
          >
            {Object.entries(LANGUAGES).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          {/* Says what the choice changes, and changes with it, so the reader sees it took effect. */}
          <p id={`${PANEL}-lang-hint`} className="settings-hint">
            Word meanings and explanations of passages come in {LANGUAGES[prefs.lang]}. The book itself stays in English.
          </p>
        </div>

        <AiHelper open={open} canChoose={canChooseAi} />
      </section>
    </>
  );
}
