import { ArrowRight, Check, ChevronLeft, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useLocation } from "wouter";
import type { PublicProfile } from "../../shared/types.ts";
import { api, ApiFailure } from "../api.ts";
import { APP_NAME, useDocumentTitle } from "../pageTitle.ts";
import { Avatar } from "./Avatar.tsx";
import { useSession } from "./session.tsx";
import { Unreachable } from "./Startup.tsx";
import { wrongCodeLine } from "./wrongCode.ts";

/** The "Who's reading?" page: everyone's picture and name, and the code that opens the one picked. */
export function ProfilesPage() {
  useDocumentTitle(`Who's reading? - ${APP_NAME}`);
  const [profiles, setProfiles] = useState<PublicProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<PublicProfile | null>(null);
  const { info, stopChoosing } = useSession();
  // Someone already signed in, looking at the profiles to switch: their own tile needs no code.
  const current = info?.mode === "profiles" ? (info.session?.profile ?? null) : null;
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
    if (profile.id === current?.id) {
      stopChoosing();
      return;
    }
    cameFrom.current = profile.id;
    setChosen(profile);
  }

  // Escape goes back to reading as oneself, as it leaves the code box for the tiles.
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (current && !chosen && event.key === "Escape") stopChoosing();
  }

  return (
    <main className="profiles-page" onKeyDown={handleKeyDown}>
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
                  {profile.id === current?.id && (
                    <span className="profile-tile-live" role="img" aria-label="Signed in" title="Signed in">
                      <Check size={18} strokeWidth={3} aria-hidden />
                    </span>
                  )}
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

/**
 * One profile's code, asked for where the tiles were: the picture, one field with its submit arrow and an eye inside it,
 * and a quiet way back. A wrong code shakes the field and says so below it, without moving anything.
 */
function CodeEntry({ profile, onBack }: { profile: PublicProfile; onBack: () => void }) {
  const { setSession } = useSession();
  const [, navigate] = useLocation();
  const inputId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts the reports, so a second wrong code fades in again, and drives the shake.
  const [reports, setReports] = useState(0);
  const [shaking, setShaking] = useState(false);
  // The line the last wrong code got, so the next one is not the same joke.
  const lastJoke = useRef<string | null>(null);

  function report(message: string, shake: boolean) {
    setError(message);
    setReports((n) => n + 1);
    setShaking(shake);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (code === "") {
      report(`Type ${profile.name}'s code to open DeepRead.`, false);
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
      if (err instanceof ApiFailure && err.code === "wrong_code") {
        lastJoke.current = wrongCodeLine(lastJoke.current);
        report(lastJoke.current, true);
      } else {
        report(err instanceof Error ? err.message : "That code could not be checked. Please try again.", false);
      }
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
        <div
          className="profile-code-box"
          data-shaking={shaking || undefined}
          data-invalid={error !== null || undefined}
          onAnimationEnd={() => setShaking(false)}
        >
          <input
            ref={input}
            id={inputId}
            name="code"
            type={shown ? "text" : "password"}
            value={code}
            placeholder="Code"
            autoFocus
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={error !== null}
            aria-describedby={errorId}
            readOnly={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          <button
            type="button"
            className="profile-code-eye"
            aria-label={shown ? "Hide the code" : "Show the code"}
            aria-pressed={shown}
            disabled={busy}
            // The field keeps focus, so the reader types on without a click back into it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setShown((was) => !was)}
          >
            {shown ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
          </button>
          <button type="submit" className="profile-code-go" aria-label={busy ? "Opening" : "Open"} disabled={busy}>
            {busy ? <LoaderCircle className="profile-spinner" size={20} aria-hidden /> : <ArrowRight size={20} aria-hidden />}
          </button>
        </div>
        {/* Always on the page, with room for a line, so nothing moves when a report arrives. */}
        <p id={errorId} className="profile-code-error" role="alert">
          {error && <span key={reports}>{error}</span>}
        </p>
      </div>
      <button type="button" className="profile-code-back" disabled={busy} onClick={onBack}>
        <ChevronLeft size={18} aria-hidden /> Choose another profile
      </button>
      <span className="visually-hidden" role="status">
        {busy ? "Checking the code" : ""}
      </span>
    </form>
  );
}
