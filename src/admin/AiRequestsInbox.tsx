import { Check } from "lucide-react";
import { useState } from "react";
import { AI_PROVIDER_HELP, AI_PROVIDERS } from "../../shared/types.ts";
import type { AdminProfile, AiProviderId, AiRequest } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { askedAgo } from "./askedAgo.ts";
import { reason } from "./profileText.ts";

type Props = {
  requests: AiRequest[];
  /** Which helpers this server can answer with: a request for one it lacks cannot be approved until it is set up. */
  ready: Partial<Record<AiProviderId, boolean>>;
  /** The profile as it is now, after a request was approved or turned down. */
  onChanged: (profile: AdminProfile) => void;
  onAnnounce: (message: string) => void;
};

/** Where to go to make a helper work, for a request that cannot be approved yet. */
const SET_UP: Record<AiProviderId, string> = {
  claude: "Install Claude Code on this computer first.",
  codex: "Install Codex on this computer first.",
  openrouter: "Set up the API Model below first.",
};

/**
 * What readers are waiting on: who asked for which helper, how long ago, and a button that gives it to them. It is the first
 * thing on the page when there is something to answer, and nothing when there is not.
 */
export function AiRequestsInbox({ requests, ready, onChanged, onAnnounce }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(request: AiRequest, approve: boolean) {
    const key = `${request.profile.id}/${request.helper}/${approve ? "yes" : "no"}`;
    setBusy(key);
    setError(null);
    try {
      const { id } = request.profile;
      const updated = approve ? await api.approveAiRequest(id, request.helper) : await api.declineAiRequest(id, request.helper);
      onChanged(updated);
      onAnnounce(
        approve
          ? `Gave ${request.profile.name} ${AI_PROVIDERS[request.helper]}.`
          : `Turned down ${request.profile.name}'s request for ${AI_PROVIDERS[request.helper]}.`,
      );
    } catch (err) {
      setError(reason(err, "That could not be done. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  if (requests.length === 0) return null;
  return (
    <section className="ai-inbox" aria-labelledby="ai-inbox-heading">
      <header className="ai-inbox-head">
        <h2 id="ai-inbox-heading">Waiting for you</h2>
        <span className="ai-inbox-count" aria-label={`${requests.length} waiting`}>
          {requests.length}
        </span>
      </header>
      <p className="admin-hint">Readers asking for an AI helper. Approve gives it to them at once.</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <ul className="ai-inbox-list">
        {requests.map((request) => {
          const { profile, helper } = request;
          const can = ready[helper] === true;
          return (
            <li key={`${profile.id}/${helper}`} className="ai-request">
              <Avatar profile={profile} size={44} />
              <div className="ai-request-body">
                <p className="ai-request-line">
                  <strong>{profile.name}</strong> asked for <strong className="ai-request-helper">{AI_PROVIDERS[helper]}</strong>
                </p>
                <p className="admin-meta">
                  Asked {askedAgo(request.requestedAt)}. {AI_PROVIDER_HELP[helper]}
                </p>
                {!can && <p className="ai-request-note">{SET_UP[helper]}</p>}
              </div>
              <div className="ai-request-actions">
                <button type="button" className="button" disabled={!can || busy !== null} onClick={() => void answer(request, true)}>
                  <Check size={16} aria-hidden /> {busy === `${profile.id}/${helper}/yes` ? "Giving..." : "Approve"}
                </button>
                <button type="button" className="quiet-button" disabled={busy !== null} onClick={() => void answer(request, false)}>
                  {busy === `${profile.id}/${helper}/no` ? "Turning down..." : "Not now"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
