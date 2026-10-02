import { Moon, Sun } from "lucide-react";
import { useEffect, useState, type FocusEvent, type ToggleEvent } from "react";
import { LANGUAGES, type AiProviderId, type AiStatus, type LangCode } from "../../shared/types.ts";
import { api } from "../api.ts";
import { FONT_SIZES, setPrefs, type Prefs } from "../prefs.ts";
import { keepingLine } from "./useReadingPosition.ts";

const PANEL = "reading-settings";

/** Tabbing on past the last control closes the menu, as a tap outside does; going back to the "Aa" button keeps it. */
function closeWhenTabbedAway(event: FocusEvent<HTMLElement>) {
  const next = event.relatedTarget;
  if (next && !event.currentTarget.contains(next) && next.getAttribute("popovertarget") !== PANEL) {
    event.currentTarget.hidePopover();
  }
}

const SETUP_HELP = "https://github.com/mrx-arafat/DeepRead#ai-helpers";

/** Which AI tool explains words and passages. Looked up each time the menu opens: one may have been installed since. */
function AiHelper({ open }: { open: boolean }) {
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
  return (
    <div className="settings-group">
      {active ? (
        <label className="settings-label" htmlFor={`${PANEL}-ai`}>
          AI helper
        </label>
      ) : (
        <p className="settings-label">AI helper</p>
      )}
      {active && status && (
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
          `${active.name} explains words and passages, signed in with your own account.`
        ) : (
          <>
            None found. Install Claude Code or Codex and sign in to get explanations; reading and listening work without one.{" "}
            <a href={SETUP_HELP} target="_blank" rel="noreferrer">
              How to set one up
            </a>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The "Aa" menu at the end of the top bar: text size, a light or dark page, the language explanations come in, and
 * the AI tool that writes them. A native popover, so a tap outside or Escape closes it and focus goes back to the
 * button, on every screen size.
 */
export function ReadingSettings({ prefs }: { prefs: Prefs }) {
  const [open, setOpen] = useState(false);
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
        <div className="settings-group" role="group" aria-labelledby={`${PANEL}-size`}>
          <p id={`${PANEL}-size`} className="settings-label">
            Text size
          </p>
          <div className="segmented">
            <button
              type="button"
              className="text-size"
              aria-label="Smaller text"
              disabled={prefs.fontSize <= FONT_SIZES.min}
              onClick={() => keepingLine(() => setPrefs({ fontSize: prefs.fontSize - 1 }))}
            >
              A
            </button>
            <button
              type="button"
              className="text-size text-size-large"
              aria-label="Larger text"
              disabled={prefs.fontSize >= FONT_SIZES.max}
              onClick={() => keepingLine(() => setPrefs({ fontSize: prefs.fontSize + 1 }))}
            >
              A
            </button>
          </div>
        </div>

        <fieldset className="settings-group">
          <legend className="settings-label">Theme</legend>
          <div className="segmented">
            <label>
              <input
                type="radio"
                name={`${PANEL}-theme`}
                value="light"
                checked={prefs.theme === "light"}
                onChange={() => setPrefs({ theme: "light" })}
              />
              <Sun size={18} aria-hidden /> Light
            </label>
            <label>
              <input
                type="radio"
                name={`${PANEL}-theme`}
                value="dark"
                checked={prefs.theme === "dark"}
                onChange={() => setPrefs({ theme: "dark" })}
              />
              <Moon size={18} aria-hidden /> Dark
            </label>
          </div>
        </fieldset>

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

        <AiHelper open={open} />
      </section>
    </>
  );
}
