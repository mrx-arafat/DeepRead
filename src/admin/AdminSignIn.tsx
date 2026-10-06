import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "wouter";
import type { PublicProfile, Session } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { reason } from "./profileText.ts";

type Props = {
  /** Whoever is reading in this browser right now, if anyone: signing in as the admin replaces them. */
  reading: PublicProfile | null;
  onSignedIn: (session: Session) => void;
};

/** A small card asking for the admin passkey, shown to anyone who opens /admin without being the admin. */
export function AdminSignIn({ reading, onSignedIn }: Props) {
  const passkeyId = useId();
  const passkeyInput = useRef<HTMLInputElement>(null);
  const [admin, setAdmin] = useState<PublicProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [passkey, setPasskey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // `current` drops the answer of a request the admin has already replaced by pressing "Try again".
    let current = true;
    setLoadError(null);
    api
      .profiles()
      .then((list) => {
        if (!current) return;
        const found = list.find((profile) => profile.admin);
        if (found) setAdmin(found);
        else setLoadError("The admin profile was not found. Check ADMIN_PASSKEY in .env, then restart DeepRead.");
      })
      .catch((err: Error) => current && setLoadError(err.message));
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (admin) passkeyInput.current?.focus();
  }, [admin]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !admin) return;
    if (passkey === "") {
      setError("Type the admin passkey.");
      passkeyInput.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.signIn(admin.id, passkey));
    } catch (err) {
      setError(reason(err, "The passkey could not be checked. Please try again."));
      passkeyInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin admin-narrow">
      <form className="admin-card" noValidate onSubmit={(event) => void submit(event)}>
        {admin && <Avatar profile={admin} size={72} />}
        <h1>Admin</h1>
        {reading && !reading.admin && (
          <p className="admin-note">
            You are reading as {reading.name}. Signing in as the admin switches this browser to the admin.
          </p>
        )}
        {loadError && (
          <>
            <p className="inline-error" role="alert">
              {loadError}
            </p>
            <button type="button" className="quiet-button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </>
        )}
        {admin && (
          <>
            <div className="shelf-field">
              <label htmlFor={passkeyId}>Admin passkey</label>
              <input
                ref={passkeyInput}
                id={passkeyId}
                type="password"
                value={passkey}
                aria-invalid={error !== null}
                autoComplete="current-password"
                readOnly={busy}
                onChange={(event) => setPasskey(event.target.value)}
              />
            </div>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="button" disabled={busy}>
              {busy ? "Opening..." : "Open admin"}
            </button>
          </>
        )}
        {!admin && !loadError && <p className="visually-hidden" role="status">Loading...</p>}
        <Link href="/" className="admin-back">
          Back to the library
        </Link>
      </form>
    </main>
  );
}
