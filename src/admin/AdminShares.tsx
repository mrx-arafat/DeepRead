import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { AdminShare } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { reason } from "./profileText.ts";

const keyOf = (share: AdminShare): string => `${share.owner.id}/${share.bookId}/${share.recipient.id}`;

const sinceText = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Under the profiles on the admin's page: every book one profile shares with another, with a way to stop each.
 * `changed` is anything that changes when the profiles do (a profile removed takes its shares with it).
 */
export function AdminShares({ changed }: { changed: unknown }) {
  const [shares, setShares] = useState<AdminShare[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .adminShares()
      .then((list) => current && setShares(list))
      .catch((err: unknown) => current && setError(reason(err, "Could not load the shared books.")));
    return () => {
      current = false;
    };
  }, [changed]);

  async function stop(share: AdminShare) {
    setStopping(keyOf(share));
    setError(null);
    try {
      await api.adminStopShare(share);
      setShares((all) => all?.filter((one) => keyOf(one) !== keyOf(share)) ?? null);
    } catch (err) {
      setError(reason(err, "Could not stop sharing that book. Please try again."));
    } finally {
      setStopping(null);
    }
  }

  return (
    <section className="admin-shares" aria-labelledby="admin-shares-heading">
      <h2 id="admin-shares-heading" className="sharing-heading">
        Shared books
      </h2>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {shares?.length === 0 && <p className="admin-quiet">No books are shared between profiles.</p>}
      {shares && shares.length > 0 && (
        <ul className="admin-share-list">
          {shares.map((share) => (
            <li key={keyOf(share)} className="admin-share">
              <p className="admin-share-who">
                <Avatar profile={share.owner} size={28} />
                <span>{share.owner.name}</span>
                <ArrowRight size={16} aria-hidden />
                <span className="visually-hidden">shares with</span>
                <Avatar profile={share.recipient} size={28} />
                <span>{share.recipient.name}</span>
              </p>
              <p className="admin-share-book">
                {share.title}
                <span className="admin-meta">Since {sinceText(share.sharedAt)}</span>
              </p>
              <button
                type="button"
                className="quiet-button"
                aria-label={`Stop sharing ${share.title} from ${share.owner.name} with ${share.recipient.name}`}
                disabled={stopping !== null}
                onClick={() => void stop(share)}
              >
                {stopping === keyOf(share) ? "Stopping..." : "Stop sharing"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
