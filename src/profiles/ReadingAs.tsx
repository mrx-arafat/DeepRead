import { useState } from "react";
import type { PublicProfile, Session } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useSession } from "./session.tsx";

/** The strip across the top of the library while the admin reads as someone else, with the way back to their own books. */
export function ReadingAs({ session, admin }: { session: Session; admin: PublicProfile }) {
  const { setSession } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      // The admin's own books replace this page: App starts the library over for the new profile.
      setSession(await api.stopImpersonating());
    } catch (err) {
      setError(err instanceof Error ? err.message : `You could not go back to ${admin.name}. Please try again.`);
      setBusy(false);
    }
  }

  return (
    <div className="reading-as">
      <div className="reading-as-inner">
        <p>
          Reading as <strong>{session.profile.name}</strong>.
        </p>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void stop()}>
          {busy ? "Going back..." : `Back to ${admin.name}`}
        </button>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
