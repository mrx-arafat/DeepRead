import { Link } from "wouter";
import { useSession } from "../profiles/session.tsx";
import { APP_NAME, useDocumentTitle } from "../pageTitle.ts";
import { AdminDashboard } from "./AdminDashboard.tsx";
import { AdminSignIn } from "./AdminSignIn.tsx";

/** /admin: where the admin manages profiles. Anyone else who opens it is asked for the admin passkey. */
export function AdminPage() {
  useDocumentTitle(`Admin - ${APP_NAME}`);
  const { info, error, retry, setSession } = useSession();

  if (!info) {
    // The first answer is on its way; App shows its own message while it waits, so this stays quiet.
    return (
      <main className="admin admin-narrow">
        {error ? (
          <div className="library-retry">
            <p className="inline-error" role="alert">
              {error}
            </p>
            <button type="button" className="quiet-button" onClick={retry}>
              Try again
            </button>
          </div>
        ) : (
          <p className="visually-hidden" role="status">
            Loading...
          </p>
        )}
      </main>
    );
  }

  if (info.mode === "single") {
    return (
      <main className="admin admin-narrow">
        <h1>Profiles are off</h1>
        <p className="admin-note">
          DeepRead is set up with one library for everyone. To turn profiles on, set ADMIN_PASSKEY (and, if you like,
          ADMIN_NAME) in the .env file and restart DeepRead.
        </p>
        <Link href="/" className="admin-back">
          Back to the library
        </Link>
      </main>
    );
  }

  const { session } = info;
  if (!session?.admin) return <AdminSignIn reading={session?.profile ?? null} onSignedIn={setSession} />;
  return <AdminDashboard session={session} />;
}
