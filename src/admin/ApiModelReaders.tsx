import { Check } from "lucide-react";
import type { AdminProfile, OpenRouterView } from "../../shared/types.ts";
import { Avatar } from "../profiles/Avatar.tsx";

type Props = {
  /** Every profile but the admin's. */
  readers: AdminProfile[];
  view: Pick<OpenRouterView, "usedToday" | "dailyLimit"> | null;
  /** The API Model can answer, so it can be given. Taking it back never waits on that. */
  ready: boolean;
  /** The name of what the card is doing now (`give-<id>` while giving it to a reader), or null. Everything waits for it. */
  busy: string | null;
  onGive: (reader: AdminProfile) => void;
  onTakeBack: (reader: AdminProfile) => void;
  onTurnDown: (reader: AdminProfile) => void;
};

/**
 * The readers on the API Model card: a switch to give each the API Model or take it back, with how much they used today,
 * and for a reader who asked for it, the means to approve or turn the request down.
 */
export function ApiModelReaders({ readers, view, ready, busy, onGive, onTakeBack, onTurnDown }: Props) {
  const changing = busy !== null;
  if (readers.length === 0) return <p className="admin-hint">Add a profile above, then give it the API Model here.</p>;
  return (
    <ul className="api-readers">
      {readers.map((reader) => {
        const has = reader.ai.includes("openrouter");
        const asked = reader.aiRequested.includes("openrouter");
        const used = view?.usedToday[reader.id] ?? 0;
        const limitNow = view?.dailyLimit ?? 0;
        return (
          <li key={reader.id} className="api-reader" data-asked={asked || undefined}>
            <Avatar profile={reader} size={36} />
            <div className="api-reader-who">
              <span className="api-reader-name">{reader.name}</span>
              {asked ? (
                <span className="api-reader-note api-reader-asked">Asked for the API Model</span>
              ) : has ? (
                <span className="api-reader-meter">
                  <span className="api-meter" aria-hidden>
                    <span style={{ width: limitNow > 0 ? `${Math.min(100, (used / limitNow) * 100)}%` : used > 0 ? "100%" : "0%" }} />
                  </span>
                  <span className="api-reader-note">
                    {used}
                    {limitNow > 0 ? ` of ${limitNow}` : ""} today
                  </span>
                </span>
              ) : (
                <span className="api-reader-note">Cannot use it</span>
              )}
            </div>
            {asked ? (
              <div className="api-reader-actions">
                <button type="button" className="button" disabled={changing || !ready} onClick={() => onGive(reader)}>
                  <Check size={16} aria-hidden /> {busy === `give-${reader.id}` ? "Giving..." : "Approve"}
                </button>
                <button type="button" className="quiet-button" disabled={changing} onClick={() => onTurnDown(reader)}>
                  Not now
                </button>
              </div>
            ) : (
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={has}
                aria-label={`Let ${reader.name} use the API Model`}
                disabled={changing || (!has && !ready)}
                onClick={() => (has ? onTakeBack(reader) : onGive(reader))}
              >
                <span className="switch-track" aria-hidden />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
