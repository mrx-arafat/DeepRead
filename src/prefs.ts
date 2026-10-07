import { useSyncExternalStore } from "react";
import { DEFAULT_LANG, HIGHLIGHT_COLORS, LANGUAGES, type HighlightColor, type LangCode } from "../shared/types.ts";

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
/** Who reads aloud: the voice built into this computer, or the natural one DeepRead runs itself once it is downloaded. */
export const VOICES = ["device", "natural"] as const;

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
  voice: (typeof VOICES)[number];
  /** Read-aloud speed, 1 = normal. */
  rate: number;
  /** The highlighter colour used last: the selection bar's Highlight button marks with it. */
  highlight: HighlightColor;
  /** A short line after each main chapter about what was just read. */
  chapterNotes: boolean;
};

export const FONT_SIZES = { min: 15, max: 26 } as const;
/** Read-aloud speeds, slow ones first, for a reader still learning to follow spoken English. */
export const RATES = [0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.5] as const;

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
    voice: "device",
    rate: 1,
    highlight: "yellow",
    chapterNotes: true,
  };
  const merged = { ...defaults, ...(typeof saved === "object" && saved !== null ? saved : {}) } as Prefs;
  // Own keys only: `in` would take an inherited name such as "toString" for a language.
  if (!Object.hasOwn(LANGUAGES, merged.lang)) merged.lang = DEFAULT_LANG;
  merged.fontSize = Number.isInteger(merged.fontSize)
    ? Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, merged.fontSize))
    : defaults.fontSize;
  // A speed the player does not offer would leave its list with nothing chosen.
  merged.rate = RATES.includes(merged.rate as (typeof RATES)[number]) ? merged.rate : defaults.rate;
  merged.theme = oneOf(THEMES, merged.theme, defaults.theme);
  merged.font = oneOf(FONTS, merged.font, defaults.font);
  merged.spacing = oneOf(SPACINGS, merged.spacing, defaults.spacing);
  merged.margins = oneOf(MARGINS, merged.margins, defaults.margins);
  merged.align = oneOf(ALIGNS, merged.align, defaults.align);
  merged.layout = oneOf(LAYOUTS, merged.layout, defaults.layout);
  merged.voice = oneOf(VOICES, merged.voice, defaults.voice);
  merged.highlight = oneOf(HIGHLIGHT_COLORS, merged.highlight, defaults.highlight);
  merged.chapterNotes = typeof merged.chapterNotes === "boolean" ? merged.chapterNotes : defaults.chapterNotes;
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
