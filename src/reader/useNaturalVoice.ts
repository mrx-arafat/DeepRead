import { useEffect } from "react";
import type { Prefs } from "../prefs.ts";
import { disableNatural, enableNatural } from "./natural.ts";
import { setNaturalVoiceWanted } from "./speech.ts";

/** Starts the natural voice while the reader has chosen it, and lets it go (and its memory) when they go back to the device's. */
export function useNaturalVoice(voice: Prefs["voice"]): void {
  useEffect(() => {
    setNaturalVoiceWanted(voice === "natural");
    if (voice === "natural") void enableNatural();
    else disableNatural();
  }, [voice]);
}
