import { useEffect, useRef, useState, type RefObject } from "react";
import type { LangCode } from "../../shared/types.ts";
import { tierParams, useDeviceTier } from "../deviceTier.ts";
import { registerTranslationPriority, setTranslationPriority } from "./translationCache.ts";

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
  const tier = useDeviceTier();

  useEffect(() => {
    if (on) return registerTranslationPriority(key, JSON.stringify([bookId, lang]), false);
  }, [on, key, bookId, lang]);

  useEffect(() => {
    if (on) setTranslationPriority(key, translateNow);
  }, [on, key, translateNow]);

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
    }, { rootMargin: tierParams().translationRootMargin });
    observer.observe(element);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [on, translateNow, key, active, activation.key, tier]);

  return { ref, eligible: on && (translateNow || active) };
}
