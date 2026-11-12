import { useEffect } from "react";
import { TIER_PARAMS, useDeviceTier } from "../deviceTier.ts";
import type { Prefs } from "../prefs.ts";
import { connectServerVoice, disableNatural, enableNatural, setNaturalBook } from "./natural.ts";
import { setNaturalVoiceWanted } from "./speech.ts";

/**
 * Keeps the natural voice with the reader's choice: let go (and its memory with it) when they go back to the device's
 * voice. When the DeepRead server reads it, it is ready as the book opens on every device, with nothing loaded. When the
 * device must run it, a computer starts it as the book opens, and a phone only when Listen is pressed (speech.ts) or the
 * voice is chosen (ReadingSettings.tsx), so opening a book never pays for a voice nobody is listening to.
 */
export function useNaturalVoice(voice: Prefs["voice"], bookId: string): void {
  const warm = TIER_PARAMS[useDeviceTier()].voiceWarmup;
  // The server reads the sentences of the book that is open.
  useEffect(() => {
    setNaturalBook(bookId);
    return () => setNaturalBook(null);
  }, [bookId]);
  useEffect(() => {
    setNaturalVoiceWanted(voice === "natural");
    if (voice !== "natural") disableNatural();
    else if (warm) void enableNatural();
    else void connectServerVoice();
  }, [voice, warm]);
}
