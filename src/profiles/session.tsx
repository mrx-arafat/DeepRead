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
  /** Signs out of this browser and shows the profiles. */
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

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
    const signedOut = () => setInfo((now) => (now?.mode === "profiles" ? { mode: "profiles", session: null } : now));
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
  }, []);

  const setSession = useCallback((session: Session | null) => setInfo({ mode: "profiles", session }), []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const signOut = useCallback(async () => {
    await api.signOut();
    setSession(null);
  }, [setSession]);

  const state = useMemo(() => ({ info, error, retry, setSession, signOut }), [info, error, retry, setSession, signOut]);
  return <SessionContext value={state}>{children}</SessionContext>;
}

export function useSession(): SessionState {
  const state = useContext(SessionContext);
  if (!state) throw new Error("useSession is used outside SessionProvider");
  return state;
}
