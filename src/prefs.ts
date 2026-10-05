import { useSyncExternalStore } from "react";
import { DEFAULT_LANG, LANGUAGES, type LangCode } from "../shared/types.ts";

/** The page colours, as on an e-reader: white paper, warm sepia paper, or light text on black. */
export const THEMES = ["light", "sepia", "dark"] as const;
/** The book text's face. The interface keeps its own. */
export const FONTS = ["serif", "sans"] as const;
/** Space between the lines of the book text. */
export const SPACINGS = ["tight", "normal", "loose"] as const;
/** How much paper is left either side of the text: wide margins make a narrower column. */
export const MARGINS = ["narrow", "normal", "wide"] as const;
export const ALIGNS = ["left", "justify"] as const;
/** The book as one long scroll, or turned a page at a time like an e-reader. */
export const LAYOUTS = ["scroll", "pages"] as const;

export type Prefs = {
  lang: LangCode;
  /** Book text size in px. */
  fontSize: number;
  theme: (typeof THEMES)[number];
  font: (typeof FONTS)[number];
  spacing: (typeof SPACINGS)[number];
  margins: (typeof MARGINS)[number];
  align: (typeof ALIGNS)[number];
  layout: (typeof LAYOUTS)[number];
  /** Read-aloud speed, 1 = normal. */
  rate: number;
};

export const FONT_SIZES = { min: 15, max: 26 } as const;

const KEY = "deepread.prefs";

/** `value` if it is one of `allowed`, else `fallback`: saved prefs may come from an older or newer DeepRead. */
function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** The reader's prefs from what was saved (anything at all), with the defaults for whatever is missing or unknown. */
export function readPrefs(saved: unknown, prefersDark: boolean): Prefs {
  const defaults: Prefs = {
    lang: DEFAULT_LANG,
    fontSize: 19,
    theme: prefersDark ? "dark" : "light",
    font: "serif",
    spacing: "normal",
    margins: "normal",
    align: "left",
    layout: "scroll",
    rate: 1,
  };
  const merged = { ...defaults, ...(typeof saved === "object" && saved !== null ? saved : {}) } as Prefs;
  if (!(merged.lang in LANGUAGES)) merged.lang = DEFAULT_LANG;
  merged.theme = oneOf(THEMES, merged.theme, defaults.theme);
  merged.font = oneOf(FONTS, merged.font, defaults.font);
  merged.spacing = oneOf(SPACINGS, merged.spacing, defaults.spacing);
  merged.margins = oneOf(MARGINS, merged.margins, defaults.margins);
  merged.align = oneOf(ALIGNS, merged.align, defaults.align);
  merged.layout = oneOf(LAYOUTS, merged.layout, defaults.layout);
  return merged;
}

function load(): Prefs {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  try {
    return readPrefs(JSON.parse(localStorage.getItem(KEY) ?? "{}"), prefersDark);
  } catch {
    return readPrefs(null, prefersDark);
  }
}

/** The look lives in the stylesheet, keyed by these attributes; only the text size is a number. */
function apply(prefs: Prefs) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.font = prefs.font;
  root.dataset.spacing = prefs.spacing;
  root.dataset.margins = prefs.margins;
  root.dataset.align = prefs.align;
  root.dataset.layout = prefs.layout;
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
