import { useEffect, useId, useState } from "react";
import { DEFAULT_LANG, LANGUAGES, TRANSLATION_ENGINES } from "../../shared/types.ts";
import type { LangCode, TranslationEngine, TranslationSettings, TranslationTest } from "../../shared/types.ts";
import { api } from "../api.ts";
import { reason } from "./profileText.ts";

const ENGINES: Record<TranslationEngine, { name: string; about: string }> = {
  auto: { name: "Automatic", about: "Microsoft first, and Google if Microsoft cannot answer." },
  microsoft: { name: "Microsoft Translator", about: "Every chapter from Microsoft." },
  google: { name: "Google Translate", about: "Every chapter from Google." },
};

/** Who answered a try, in a sentence. */
const ANSWERED_BY = { microsoft: "Microsoft", google: "Google" } as const;

/**
 * Chapter translation, as a card on the admin's page like the API Model's: whether readers may show a chapter in their own
 * language under each paragraph, which free service translates it, and a try of that service on one sentence. It is a
 * translation service, not an AI helper, so it costs nothing and uses no one's AI.
 */
export function AdminTranslation() {
  const id = useId();
  const [settings, setSettings] = useState<TranslationSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<"enabled" | "engine" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<LangCode>(DEFAULT_LANG);
  // The try's answer with the language it was in, which the select may since have moved from.
  const [tried, setTried] = useState<{ lang: LangCode; result: TranslationTest } | null>(null);

  useEffect(() => {
    // `current` drops the answer of a request the admin has already replaced by pressing "Try again".
    let current = true;
    setLoadError(null);
    api
      .adminTranslation()
      .then((found) => current && setSettings(found))
      .catch((err: unknown) => current && setLoadError(reason(err, "The translation settings could not be loaded.")));
    return () => {
      current = false;
    };
  }, [attempt]);

  /** Shows the change at once, and puts back what was there if the server does not keep it. */
  async function change(name: "enabled" | "engine", patch: Partial<TranslationSettings>) {
    if (settings === null || busy !== null) return;
    const before = settings;
    setSettings({ ...settings, ...patch });
    setBusy(name);
    setError(null);
    if (name === "engine") setTried(null);
    try {
      setSettings(await api.saveAdminTranslation(patch));
    } catch (err) {
      setSettings(before);
      setError(reason(err, "That could not be saved. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    if (busy !== null) return;
    const asked = lang;
    setBusy("test");
    setError(null);
    setTried(null);
    try {
      setTried({ lang: asked, result: await api.testAdminTranslation(asked) });
    } catch (err) {
      setTried({ lang: asked, result: { ok: false, message: reason(err, "The service could not be tried. Please try again.") } });
    } finally {
      setBusy(null);
    }
  }

  const result = tried?.result;
  return (
    <section id="chapter-translation" className="api-card" aria-labelledby="chapter-translation-heading">
      <header className="api-card-head">
        <div>
          <h2 id="chapter-translation-heading">Chapter translation</h2>
          <p className="admin-hint api-card-intro">
            Readers can show a whole chapter in their own language, under each paragraph. A free translation service does it, not
            an AI helper, so it costs nothing and uses no one&apos;s AI. Each paragraph is translated once and kept with the book for
            everyone.
          </p>
        </div>
        {settings && (
          <div className="api-card-actions">
            <span className="api-chip" data-tone={settings.enabled ? "ready" : undefined}>
              {settings.enabled ? "On for readers" : "Off for readers"}
            </span>
          </div>
        )}
      </header>

      {error && (
        <p className="inline-error api-card-error" role="alert">
          {error}
        </p>
      )}

      {settings === null && !loadError && <p className="admin-hint api-card-state">Loading the translation settings...</p>}
      {loadError && (
        <div className="library-retry">
          <p className="inline-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="quiet-button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {settings && (
        <ul className="api-settings">
          <li className="api-setting">
            <div className="api-setting-row">
              <div>
                <h3 id={`${id}-enabled`}>Let readers translate chapters</h3>
                <p id={`${id}-enabled-hint`} className="admin-hint">
                  You can always translate a chapter yourself, on or off.
                </p>
              </div>
              {/* aria-disabled, not disabled, while saving: a disabled control loses the keyboard's focus. */}
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={settings.enabled}
                aria-labelledby={`${id}-enabled`}
                aria-describedby={`${id}-enabled-hint`}
                aria-disabled={busy !== null || undefined}
                onClick={() => void change("enabled", { enabled: !settings.enabled })}
              >
                <span className="switch-track" aria-hidden />
              </button>
            </div>
          </li>

          <li className="api-setting">
            <fieldset className="api-choices" aria-describedby={`${id}-engines-note`}>
              <legend>
                <h3>Translation service</h3>
              </legend>
              <div className="api-choice-grid">
                {TRANSLATION_ENGINES.map((engine) => (
                  <div key={engine} className="api-choice">
                    <label className="api-choice-pick">
                      {/* While a choice is saved the others wait; the chosen one keeps the focus it has. */}
                      <input
                        type="radio"
                        name={`${id}-engine`}
                        value={engine}
                        checked={settings.engine === engine}
                        disabled={busy !== null && settings.engine !== engine}
                        aria-labelledby={`${id}-${engine}`}
                        aria-describedby={`${id}-${engine}-about`}
                        onChange={() => void change("engine", { engine })}
                      />
                      <span id={`${id}-${engine}`} className="api-choice-name">
                        {ENGINES[engine].name}
                        {engine === "auto" && <span className="api-choice-tag">Recommended</span>}
                      </span>
                      <span id={`${id}-${engine}-about`} className="api-choice-about">
                        {ENGINES[engine].about}
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </fieldset>
            <p id={`${id}-engines-note`} className="admin-hint api-choices-note">
              Both are free public services that need no account. Now and then one is slow or refuses, which is why Automatic tries
              the other.
            </p>
          </li>

          <li className="api-setting">
            <div className="api-setting-row">
              <div>
                <h3>Try it</h3>
                <p className="admin-hint">Translates one sentence with the service chosen above.</p>
              </div>
              <div className="api-setting-actions api-try">
                <label htmlFor={`${id}-lang`} className="api-try-label">
                  Into
                </label>
                <select id={`${id}-lang`} value={lang} onChange={(event) => setLang(event.target.value as LangCode)}>
                  {Object.entries(LANGUAGES).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
                <button type="button" className="quiet-button" aria-disabled={busy !== null || undefined} onClick={() => void test()}>
                  {busy === "test" ? "Translating..." : "Translate"}
                </button>
              </div>
            </div>
            <p className="admin-hint api-test" role="status">
              {result?.ok ? `Works. ${ANSWERED_BY[result.engine]} answered in ${(result.ms / 1000).toFixed(1)} s.` : ""}
            </p>
            {result?.ok && tried && (
              <blockquote className="api-sample">
                <p lang="en">{result.sample}</p>
                <p lang={tried.lang} dir="auto">
                  {result.translation}
                </p>
              </blockquote>
            )}
            {result && !result.ok && (
              <p className="inline-error api-test" role="alert">
                {result.message}
              </p>
            )}
          </li>
        </ul>
      )}
    </section>
  );
}
