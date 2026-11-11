import { useEffect } from "react";
import { TIER_PARAMS, useDeviceTier } from "../deviceTier.ts";
import type { Prefs } from "../prefs.ts";
import { disableNatural, enableNatural } from "./natural.ts";
import { setNaturalVoiceWanted } from "./speech.ts";

/**
 * Keeps the natural voice with the reader's choice: let go (and its memory with it) when they go back to the device's
 * voice, and on a computer started as the book opens. On a phone it starts only when Listen is pressed (speech.ts) or
 * the voice is chosen (ReadingSettings.tsx), so opening a book never pays for a voice nobody is listening to.
 */
export function useNaturalVoice(voice: Prefs["voice"]): void {
  const warm = TIER_PARAMS[useDeviceTier()].voiceWarmup;
  useEffect(() => {
    setNaturalVoiceWanted(voice === "natural");
    if (voice !== "natural") disableNatural();
    else if (warm) void enableNatural();
  }, [voice, warm]);
}
