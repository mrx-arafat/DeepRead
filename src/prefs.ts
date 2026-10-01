import { useSyncExternalStore } from "react";
import { DEFAULT_LANG, LANGUAGES, type LangCode } from "../shared/types.ts";

export type Prefs = {
  lang: LangCode;
  /** Book text size in px. */
  fontSize: number;
  theme: "light" | "dark";
  /** Read-aloud speed, 1 = normal. */
  rate: number;
};

export const FONT_SIZES = { min: 15, max: 26 } as const;

const KEY = "deepread.prefs";

function load(): Prefs {
  const defaults: Prefs = {
    lang: DEFAULT_LANG,
    fontSize: 19,
    theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    rate: 1,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    const merged = { ...defaults, ...saved };
    if (!(merged.lang in LANGUAGES)) merged.lang = DEFAULT_LANG;
    return merged;
  } catch {
    return defaults;
  }
}

function apply(prefs: Prefs) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.style.setProperty("--book-size", `${prefs.fontSize}px`);
}

let current = load();
apply(current);
const listeners = new Set<() => void>();

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  apply(current);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode or full storage: the choice still holds for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => current);
}
