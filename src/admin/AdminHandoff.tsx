import { useEffect, useId, useState } from "react";
import type { HandoffSettings } from "../../shared/types.ts";
import { api } from "../api.ts";
import { reason } from "./profileText.ts";

/**
 * Open in ChatGPT, as a card on the admin's page like chapter translation's: whether readers get the button that hands
 * a passage to ChatGPT, Claude, Perplexity or Google AI Mode. Built in the browser alone, it costs nothing here and uses
 * no one's AI helper; the passage goes to that company, which is why the admin can turn it off.
 */
export function AdminHandoff() {
  const id = useId();
  const [settings, setSettings] = useState<HandoffSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoadError(null);
    api
      .adminHandoff()
      .then((found) => current && setSettings(found))
      .catch((err: unknown) => current && setLoadError(reason(err, "The Open in ChatGPT setting could not be loaded.")));
    return () => {
      current = false;
    };
  }, [attempt]);

  /** Shows the change at once, and puts back what was there if the server does not keep it. */
  async function change(enabled: boolean) {
    if (settings === null || busy) return;
    const before = settings;
    setSettings({ enabled });
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.saveAdminHandoff({ enabled }));
    } catch (err) {
      setSettings(before);
      setError(reason(err, "That could not be saved. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="open-in-chatgpt" className="api-card" aria-labelledby="open-in-chatgpt-heading">
      <header className="api-card-head">
        <div>
          <h2 id="open-in-chatgpt-heading">Open in ChatGPT</h2>
          <p className="admin-hint api-card-intro">
            Readers can hand a passage to ChatGPT, Claude, Perplexity or Google AI Mode for a longer answer, in their own account
            there. DeepRead only opens the chat with the passage and a prompt filled in, so it costs nothing here and uses no
            one&apos;s AI helper. The passage goes to that company.
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

      {settings === null && !loadError && <p className="admin-hint api-card-state">Loading the setting...</p>}
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
                <h3 id={`${id}-enabled`}>Let readers open deep dives in an outside chat</h3>
                <p id={`${id}-enabled-hint`} className="admin-hint">
                  You can always open one yourself, on or off.
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
                aria-disabled={busy || undefined}
                onClick={() => void change(!settings.enabled)}
              >
                <span className="switch-track" aria-hidden />
              </button>
            </div>
          </li>
        </ul>
      )}
    </section>
  );
}
