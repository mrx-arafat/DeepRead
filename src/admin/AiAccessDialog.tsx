import { useId, useLayoutEffect, useRef, useState } from "react";
import { AI_PROVIDER_HELP, AI_PROVIDERS } from "../../shared/types.ts";
import type { AdminProfile, AiProviderId, AiStatus } from "../../shared/types.ts";
import { api } from "../api.ts";
import { reason } from "./profileText.ts";

type Props = {
  profile: AdminProfile;
  /** What this server can answer with, as the admin sees it. */
  helpers: AiStatus;
  onChange: (profile: AdminProfile) => void;
  onClose: () => void;
};

/**
 * Which AI helpers one reader may use: a switch for each, applied at once, with what they have asked for marked. The admin
 * decides here; the reader sees only what is switched on, and can ask for what is installed but not theirs. A helper the
 * server does not have cannot be switched on, and one that was given and is gone can still be switched off.
 */
export function AiAccessDialog({ profile, helpers, onChange, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [changing, setChanging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const box = dialog.current;
    box?.showModal();
    return () => {
      if (box?.open) box.close();
    };
  }, []);

  async function update(key: string, patch: { ai?: AiProviderId[]; aiDismiss?: AiProviderId[] }) {
    setChanging(key);
    setError(null);
    try {
      onChange(await api.updateProfile(profile.id, patch));
    } catch (err) {
      setError(reason(err, "That could not be saved. Please try again."));
    } finally {
      setChanging(null);
    }
  }

  const toggle = (id: AiProviderId) =>
    update(id, { ai: profile.ai.includes(id) ? profile.ai.filter((one) => one !== id) : [...profile.ai, id] });

  return (
    <dialog
      ref={dialog}
      className="shelf-dialog share-dialog"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <h2 id={headingId}>AI helpers for {profile.name}</h2>
      <p className="share-intro">
        {profile.name} can use only what you switch on. Everything else shows as theirs to ask you for.
      </p>
      <ul className="share-people">
        {helpers.providers.map((helper) => {
          const on = profile.ai.includes(helper.id);
          const asked = profile.aiRequested.includes(helper.id);
          const offNote = helper.id === "openrouter" ? (helper.detail ?? "needs an API key") : "not installed on this server";
          return (
            <li key={helper.id} className="share-person ai-person">
              <span className="share-who">
                <span className="share-name">{AI_PROVIDERS[helper.id]}</span>
                <span className="share-state">
                  {helper.installed ? AI_PROVIDER_HELP[helper.id] : `Cannot be given: ${offNote}.`}
                </span>
                {asked && (
                  <span className="ai-asked">
                    Asked for this.{" "}
                    <button type="button" className="link-button" disabled={changing !== null} onClick={() => void update(`dismiss-${helper.id}`, { aiDismiss: [helper.id] })}>
                      Turn down
                    </button>
                  </span>
                )}
              </span>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={on}
                aria-label={`Give ${profile.name} ${AI_PROVIDERS[helper.id]}`}
                disabled={changing !== null || (!helper.installed && !on)}
                onClick={() => void toggle(helper.id)}
              >
                <span className="switch-track" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="shelf-edit-actions">
        <button type="button" className="button" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}
