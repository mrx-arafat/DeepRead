import { useEffect, useState } from "react";
import { streamText } from "../api.ts";

export type AiStream = {
  text: string;
  status: "idle" | "loading" | "done" | "error";
  error: string | null;
  retry: () => void;
};

/** Runs one streaming AI request and keeps its growing text. Aborts when the caller goes away. */
export function useAiStream(path: string, body: unknown, enabled = true): AiStream {
  const key = JSON.stringify(body);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<AiStream, "retry">>({
    text: "",
    status: "idle",
    error: null,
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ text: "", status: "loading", error: null });
    streamText(path, JSON.parse(key), (text) => setState({ text, status: "loading", error: null }), controller.signal)
      .then((text) => setState({ text, status: "done", error: null }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "The explanation could not be loaded.";
        setState((prev) => ({ text: prev.text, status: "error", error: message }));
      });
    return () => controller.abort();
  }, [path, key, enabled, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
