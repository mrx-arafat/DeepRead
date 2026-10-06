import { ChevronLeft, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useLocation } from "wouter";
import type { PublicProfile } from "../../shared/types.ts";
import { api } from "../api.ts";
import { APP_NAME, useDocumentTitle } from "../pageTitle.ts";
import { Avatar } from "./Avatar.tsx";
import { useSession } from "./session.tsx";
import { Unreachable } from "./Startup.tsx";

/** The "Who's reading?" page: everyone's picture and name, and the code that opens the one picked. */
export function ProfilesPage() {
  useDocumentTitle(`Who's reading? - ${APP_NAME}`);
  const [profiles, setProfiles] = useState<PublicProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<PublicProfile | null>(null);
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  // The tile the reader came from, so Back puts keyboard focus on it again instead of dropping it on the page.
  const cameFrom = useRef<string | null>(null);

  useEffect(() => {
    // `current` drops the answer of a request the reader has already replaced by pressing "Try again".
    let current = true;
    setLoadError(null);
    api
      .profiles()
      .then((list) => current && setProfiles(list))
      .catch((err: Error) => current && setLoadError(err.message));
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (chosen !== null || cameFrom.current === null) return;
    tiles.current.get(cameFrom.current)?.focus();
    cameFrom.current = null;
  }, [chosen]);

  function choose(profile: PublicProfile) {
    cameFrom.current = profile.id;
    setChosen(profile);
  }

  return (
    <main className="profiles-page">
      <h1 className="profiles-heading">Who's reading?</h1>
      {chosen ? (
        <CodeEntry key={chosen.id} profile={chosen} onBack={() => setChosen(null)} />
      ) : loadError ? (
        <Unreachable message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
      ) : profiles === null ? (
        // The grid keeps the height the tiles will take, so nothing moves when they arrive.
        <>
          <div className="profile-grid" aria-hidden>
            {[0, 1, 2, 3].map((n) => (
              <span key={n} className="skeleton profile-skeleton" />
            ))}
          </div>
          <p className="visually-hidden" role="status">
            Loading profiles
          </p>
        </>
      ) : profiles.length === 0 ? (
        <p className="profiles-empty">No profiles were found. Ask whoever set up DeepRead to add yours.</p>
      ) : (
        <ul className="profile-grid">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <button
                type="button"
                className="profile-tile"
                ref={(element) => {
                  if (element) tiles.current.set(profile.id, element);
                  else tiles.current.delete(profile.id);
                }}
                onClick={() => choose(profile)}
              >
                <span className="profile-tile-art">
                  <Avatar profile={profile} size={136} />
                </span>
                <span className="profile-tile-name">{profile.name}</span>
                {profile.admin && <span className="profile-tile-mark">Admin</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** One profile's code, asked for where the tiles were. */
function CodeEntry({ profile, onBack }: { profile: PublicProfile; onBack: () => void }) {
  const { setSession } = useSession();
  const [, navigate] = useLocation();
  const inputId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (code === "") {
      setError(`Type ${profile.name}'s code to open DeepRead.`);
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api.signIn(profile.id, code);
      // The shelf, not the page the last session was left on: that book belonged to someone else.
      navigate("/");
      setSession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code could not be checked. Please try again.");
      setBusy(false);
      // Pressing the button disabled it, which dropped focus; the reader is about to retype.
      input.current?.focus();
      input.current?.select();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    // Escape also ends an input-method composition; that must not leave the form.
    if (event.key === "Escape" && !busy && !event.nativeEvent.isComposing) onBack();
  }

  return (
    <form className="profile-code" noValidate onSubmit={(event) => void submit(event)} onKeyDown={handleKeyDown}>
      <span className="profile-code-art">
        <Avatar profile={profile} size={176} />
      </span>
      <label className="profile-code-label" htmlFor={inputId}>
        Enter {profile.name}'s code
      </label>
      <div className="profile-code-field">
        <input
          ref={input}
          id={inputId}
          name="code"
          type="password"
          value={code}
          autoFocus
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          readOnly={busy}
          onChange={(event) => setCode(event.target.value)}
        />
        {/* Always on the page, so the line is already reserved and the buttons do not drop when an error arrives. */}
        <p id={errorId} className="inline-error profile-code-error" role="alert">
          {error}
        </p>
      </div>
      <div className="profile-code-actions">
        <button type="submit" className="button" disabled={busy}>
          {busy ? (
            <>
              <LoaderCircle className="profile-spinner" size={18} aria-hidden /> Opening
            </>
          ) : (
            "Open"
          )}
        </button>
        <button type="button" className="quiet-button" disabled={busy} onClick={onBack}>
          <ChevronLeft size={18} aria-hidden /> Back
        </button>
      </div>
      <span className="visually-hidden" role="status">
        {busy ? "Checking the code" : ""}
      </span>
    </form>
  );
}
