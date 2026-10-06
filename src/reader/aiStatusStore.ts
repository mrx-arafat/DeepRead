import { useEffect, useSyncExternalStore } from "react";
import type { AiStatus } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useSession } from "../profiles/session.tsx";
import { helperCredit } from "./helperCredit.ts";

// The AI helper as this reader sees it, kept once for every place that mentions it: the Aa menu, which changes it, and the
// answers, which say whose it is. The menu hands over what it learns, so the answers follow a pick at once.
let status: AiStatus | null = null;
let belongsTo: string | null = null;
let loading = false;
const listeners = new Set<() => void>();

export function setAiStatus(next: AiStatus | null, reader: string): void {
  status = next;
  belongsTo = reader;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Who is reading: the key their status is kept under. */
export function useReaderKey(): string {
  const { info } = useSession();
  return info?.mode === "profiles" ? (info.session?.profile.id ?? "nobody") : "single";
}

/** The helper's status for the reader now reading, fetched once for them. */
export function useAiStatus(): AiStatus | null {
  const reader = useReaderKey();
  const known = useSyncExternalStore(subscribe, () => status);
  useEffect(() => {
    if (belongsTo === reader || loading) return;
    // Another reader: what was known was theirs.
    status = null;
    loading = true;
    api
      .aiStatus()
      .then((found) => setAiStatus(found, reader))
      .catch(() => {})
      .finally(() => {
        loading = false;
      });
  }, [reader, known]);
  return belongsTo === reader ? known : null;
}

/** "Arafat's Claude Code" for a reader the admin gave a helper; null otherwise. */
export function useHelperCredit(): string | null {
  const { info } = useSession();
  const isReader = info?.mode === "profiles" && info.session !== null && !(info.session.admin && !info.session.impersonatedBy);
  return helperCredit(useAiStatus(), isReader);
}
