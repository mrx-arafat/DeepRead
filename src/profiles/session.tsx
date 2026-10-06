import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Session, SessionInfo } from "../../shared/types.ts";
import { api, SIGNED_OUT_EVENT } from "../api.ts";

export type SessionState = {
  /** Null while DeepRead is first asked; then whether there are profiles, and who is signed in. */
  info: SessionInfo | null;
  /** Why the first question failed (DeepRead not reachable), with `retry` to ask again. */
  error: string | null;
  retry: () => void;
  /** The session after signing in, viewing as someone, or stopping (null: signed out). */
  setSession: (session: Session | null) => void;
  /** Whether a signed-in reader is looking at the profiles to pick someone else. Their own sign-in stands meanwhile. */
  choosing: boolean;
  /** Shows the profiles without ending the reader's session: picking themselves again needs no code. */
  startChoosing: () => void;
  /** Goes back to reading as the reader who is signed in. */
  stopChoosing: () => void;
  /** Signs out of this browser and shows the profiles. */
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    let current = true;
    setError(null);
    api
      .session()
      .then((answer) => current && setInfo(answer))
      .catch((err: Error) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [attempt]);

  // Any request that finds the session gone (30 days passed, the code was changed, the profile removed) lands here.
  useEffect(() => {
    const signedOut = () => {
      setChoosing(false);
      setInfo((now) => (now?.mode === "profiles" ? { mode: "profiles", session: null } : now));
    };
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
  }, []);

  const setSession = useCallback((session: Session | null) => {
    setChoosing(false);
    setInfo({ mode: "profiles", session });
  }, []);
  const startChoosing = useCallback(() => setChoosing(true), []);
  const stopChoosing = useCallback(() => setChoosing(false), []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const signOut = useCallback(async () => {
    await api.signOut();
    setSession(null);
  }, [setSession]);

  const state = useMemo(
    () => ({ info, error, retry, setSession, choosing, startChoosing, stopChoosing, signOut }),
    [info, error, retry, setSession, choosing, startChoosing, stopChoosing, signOut],
  );
  return <SessionContext value={state}>{children}</SessionContext>;
}

export function useSession(): SessionState {
  const state = useContext(SessionContext);
  if (!state) throw new Error("useSession is used outside SessionProvider");
  return state;
}
