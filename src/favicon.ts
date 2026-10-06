import { useEffect } from "react";
import type { Prefs } from "./prefs.ts";

/** The cloth of the library's first cover in each theme: the same colours as --cloth-1 (and, for sepia, --cloth-10) in the stylesheet. */
const CLOTH: Record<Prefs["theme"], string> = { light: "#7a2e2b", sepia: "#8a3f22", dark: "#a03c39" };
/** The ink the covers are stamped in. */
const INK = "#fbf5e6";

// public/favicon.svg, which the page starts with, draws these two shapes too: favicon.test.ts keeps them the same.
export const RIBBON = "M18 0h7.5v17.5l-3.75-3.2-3.75 3.2z";
export const TEXT_LINES = "M12.5 23h13M12.5 27.5h8";

/** The icon for a theme: the cover's cloth with its spine, a ribbon marking the place, and two lines of text. */
export function faviconSvg(theme: Prefs["theme"]): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<clipPath id="t"><rect width="32" height="32" rx="6.5"/></clipPath>' +
    '<g clip-path="url(#t)">' +
    `<rect width="32" height="32" fill="${CLOTH[theme]}"/>` +
    '<rect width="7" height="32" fill="#000" opacity="0.24"/>' +
    `<rect x="7" width="1.4" height="32" fill="${INK}" opacity="0.4"/>` +
    `<path d="${RIBBON}" fill="${INK}"/>` +
    `<path d="${TEXT_LINES}" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>` +
    "</g></svg>"
  );
}

export const faviconHref = (theme: Prefs["theme"]): string => `data:image/svg+xml,${encodeURIComponent(faviconSvg(theme))}`;

/** Keeps the tab's icon the colour of the reader's theme: the file the page starts with is the light one. */
export function useFavicon(theme: Prefs["theme"]): void {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
    if (link) link.href = faviconHref(theme);
  }, [theme]);
}
