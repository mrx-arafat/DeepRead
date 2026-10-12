import { useEffect, useRef, useState, type RefObject } from "react";
import type { LangCode } from "../../shared/types.ts";

/** The opening chapter starts immediately; other loaded chapters translate when approached.
 * Once approached, a chapter keeps its translation while the reader scrolls away from it. */
export function useChapterTranslationEligibility(
  bookId: string,
  chapterId: string,
  lang: LangCode,
  on: boolean,
  translateNow = false,
): { ref: RefObject<HTMLElement | null>; eligible: boolean } {
  const ref = useRef<HTMLElement | null>(null);
  const key = JSON.stringify([bookId, chapterId, lang]);
  const [activation, setActivation] = useState({ key, active: false });
  const active = activation.key === key && activation.active;

  useEffect(() => {
    if (!on) {
      if (activation.key !== key || activation.active) setActivation({ key, active: false });
      return;
    }
    if (translateNow) {
      if (!active) setActivation({ key, active: true });
      return;
    }
    if (activation.key !== key) {
      setActivation({ key, active: false });
      return;
    }
    if (active) return;
    const element = ref.current;
    if (!element) return;
    // Older browsers retain translation support even without visibility observation.
    if (typeof IntersectionObserver === "undefined") {
      setActivation({ key, active: true });
      return;
    }
    let live = true;
    const observer = new IntersectionObserver((entries) => {
      if (live && entries.some((entry) => entry.isIntersecting)) {
        live = false;
        setActivation({ key, active: true });
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px 600px 0px" });
    observer.observe(element);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [on, translateNow, key, active, activation.key]);

  return { ref, eligible: on && (translateNow || active) };
}
