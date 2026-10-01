import { Moon, Sun } from "lucide-react";
import type { FocusEvent } from "react";
import { LANGUAGES, type LangCode } from "../../shared/types.ts";
import { FONT_SIZES, setPrefs, type Prefs } from "../prefs.ts";

const PANEL = "reading-settings";

/** Tabbing on past the last control closes the menu, as a tap outside does; going back to the "Aa" button keeps it. */
function closeWhenTabbedAway(event: FocusEvent<HTMLElement>) {
  const next = event.relatedTarget;
  if (next && !event.currentTarget.contains(next) && next.getAttribute("popovertarget") !== PANEL) {
    event.currentTarget.hidePopover();
  }
}

/**
 * The "Aa" menu at the end of the top bar: text size, a light or dark page, and the language explanations come in.
 * A native popover, so a tap outside or Escape closes it and focus goes back to the button, on every screen size.
 */
export function ReadingSettings({ prefs }: { prefs: Prefs }) {
  return (
    <>
      <button type="button" className="icon-button settings-button" popoverTarget={PANEL} aria-label="Reading settings">
        Aa
      </button>
      <section id={PANEL} popover="auto" className="popover settings" aria-label="Reading settings" onBlur={closeWhenTabbedAway}>
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
              onClick={() => setPrefs({ fontSize: prefs.fontSize - 1 })}
            >
              A
            </button>
            <button
              type="button"
              className="text-size text-size-large"
              aria-label="Larger text"
              disabled={prefs.fontSize >= FONT_SIZES.max}
              onClick={() => setPrefs({ fontSize: prefs.fontSize + 1 })}
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
      </section>
    </>
  );
}
