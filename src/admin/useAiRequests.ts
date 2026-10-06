import { useCallback, useEffect, useState } from "react";
import type { AiRequest } from "../../shared/types.ts";
import { api } from "../api.ts";

/**
 * What readers have asked the admin for, kept fresh: fetched when asked to, then again every `everyMs` while the page is
 * in view, and the moment it comes back into view. A page that is only loaded once would say nothing of a request made
 * after it was opened, which is when the admin most needs to hear of it.
 */
export function useAiRequests(everyMs: number, enabled = true): { requests: AiRequest[]; refresh: () => Promise<void> } {
  const [requests, setRequests] = useState<AiRequest[]>([]);

  const refresh = useCallback(async () => {
    try {
      setRequests(await api.aiRequests());
    } catch {
      // The next look tries again; a request list that cannot be had is no reason to break the page.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, everyMs);
    const seen = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("focus", seen);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("focus", seen);
    };
  }, [enabled, everyMs, refresh]);

  return { requests, refresh };
}
