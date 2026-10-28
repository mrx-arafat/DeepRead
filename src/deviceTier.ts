// How much reading work this device can take. Three tiers: the desktop path as it is today, a phone, and a slow phone.
// Every number the reader varies by tier lives in TIER_PARAMS, so tuning from measurements is a one-file change.
// The tier is resolved once from the device's signals and the reader's override ("Light reading for slower phones"),
// and can be raised to "low" while reading when the page measures long frames; `useDeviceTier` re-renders on a change.
import { useSyncExternalStore } from "react";

export type Tier = "desktop" | "normal" | "low";

/** The reader's choice in Reading settings: Auto follows the device, On and Off force a tier. Kept per device. */
export type TierOverride = "auto" | "on" | "off";

/** What the browser says about the device; every field may be missing where a browser does not expose it. */
export type TierSignals = {
  /** `(pointer: fine)` matches: a mouse or trackpad rather than a finger. */
  finePointer: boolean;
  /** The viewport is at least 72rem wide: the margin-note breakpoint, where the desktop layout begins. */
  wideViewport: boolean;
  /** `navigator.deviceMemory`, a power of two in GiB; absent on Safari and Firefox. */
  deviceMemory?: number;
  /** `navigator.hardwareConcurrency`. */
  hardwareConcurrency?: number;
  /** `navigator.connection.saveData` or `(prefers-reduced-data: reduce)`. */
  saveData: boolean;
};

export type TierParams = {
  /** Text chunks are mount units: far ones become placeholders. Off keeps every chunk mounted, as today on desktop. */
  windowing: boolean;
  /** Rows of book text per chunk. */
  rowsPerChunk: number;
  /** IntersectionObserver rootMargin inside which a chunk mounts (percentages are of the viewport). */
  mountRootMargin: string;
  /** rootMargin a mounted chunk must leave before it unmounts: wider than mountRootMargin, so a chunk at the edge does not flap. */
  keepRootMargin: string;
  /** Chunks mounted at open before the observers report, besides the chunk holding the saved place. */
  initialChunks: number;
  /** Chapter data kept after a chapter leaves the page, so coming back is instant. */
  chapterCacheEntries: number;
  chapterCacheChars: number;
  /** Chapters kept on the page at once; the far end is trimmed beyond this. */
  knownChapters: number;
  /** Chapter translations kept after their chapter leaves the page. */
  translationCacheEntries: number;
  translationCacheChars: number;
  /** Chapter translation requests out at once. */
  translationInFlight: number;
  /** rootMargin inside which a chapter that is not at the eye line asks for its translation. */
  translationRootMargin: string;
  /** Ask for a neighbour's translation from idle time, after the eye-line chapter's has been applied. */
  translationAtIdle: boolean;
  /** How long after the last scroll the reading position is measured. */
  measureDebounceMs: number;
  /** How often a visible page looks for notes made on another device; 0 means only on focus, visibility, online and storage events. */
  notesPollMs: number;
  /** Transitions and streaming animations in the reader. */
  animations: boolean;
};

/** The desktop row is today's behaviour; the phone rows start from the design and are tuned from measurements. */
export const TIER_PARAMS: Record<Tier, TierParams> = {
  desktop: {
    windowing: false,
    rowsPerChunk: 48,
    mountRootMargin: "0px",
    keepRootMargin: "0px",
    initialChunks: Infinity,
    chapterCacheEntries: 40,
    chapterCacheChars: 6_000_000,
    knownChapters: Infinity,
    translationCacheEntries: 40,
    translationCacheChars: 2_000_000,
    translationInFlight: Infinity,
    translationRootMargin: "600px 0px 600px 0px",
    translationAtIdle: false,
    measureDebounceMs: 150,
    notesPollMs: 30_000,
    animations: true,
  },
  normal: {
    windowing: true,
    rowsPerChunk: 48,
    mountRootMargin: "150% 0px 150% 0px",
    keepRootMargin: "300% 0px 300% 0px",
    initialChunks: 3,
    chapterCacheEntries: 40,
    chapterCacheChars: 6_000_000,
    knownChapters: 10,
    translationCacheEntries: 40,
    translationCacheChars: 2_000_000,
    translationInFlight: 2,
    translationRootMargin: "150% 0px 150% 0px",
    translationAtIdle: false,
    measureDebounceMs: 150,
    notesPollMs: 120_000,
    animations: true,
  },
  low: {
    windowing: true,
    rowsPerChunk: 24,
    mountRootMargin: "100% 0px 100% 0px",
    keepRootMargin: "200% 0px 200% 0px",
    initialChunks: 2,
    chapterCacheEntries: 12,
    chapterCacheChars: 2_000_000,
    knownChapters: 5,
    translationCacheEntries: 12,
    translationCacheChars: 600_000,
    translationInFlight: 1,
    translationRootMargin: "100% 0px 100% 0px",
    translationAtIdle: true,
    measureDebounceMs: 250,
    notesPollMs: 0,
    animations: false,
  },
};

/**
 * The tier for these signals, the reader's override and whether long frames were measured on this device.
 * Pure, so it is tested without a browser. The device rules (memory, cores, Save-Data, measurement) are filled in by
 * the device tier slice; until then a wide screen with a fine pointer is the desktop and everything else a phone.
 */
export function resolveTier(signals: TierSignals, override: TierOverride, measured: boolean): Tier {
  void measured;
  if (override === "on") return "low";
  return signals.finePointer && signals.wideViewport ? "desktop" : "normal";
}

/** The signals as this browser reports them; safe where there is no window (tests, the server build). */
export function readSignals(): TierSignals {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { finePointer: true, wideViewport: true, saveData: false };
  }
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return {
    finePointer: window.matchMedia("(pointer: fine)").matches,
    wideViewport: window.matchMedia("(min-width: 72rem)").matches,
    ...(typeof nav.deviceMemory === "number" ? { deviceMemory: nav.deviceMemory } : {}),
    ...(typeof nav.hardwareConcurrency === "number" ? { hardwareConcurrency: nav.hardwareConcurrency } : {}),
    saveData: nav.connection?.saveData === true || window.matchMedia("(prefers-reduced-data: reduce)").matches,
  };
}

let override: TierOverride = "auto";
let measured = false;
let current: Tier | null = null;
const listeners = new Set<() => void>();

/** The tier now, resolved on first use. */
export function deviceTier(): Tier {
  current ??= resolveTier(readSignals(), override, measured);
  return current;
}

/** The parameters for the tier now. */
export function tierParams(): TierParams {
  return TIER_PARAMS[deviceTier()];
}

/**
 * Resolves the tier again with a new override or measurement (a window resize counts too, with neither given), and tells
 * `useDeviceTier` readers when it changed. The device tier slice calls this from the setting and from its measurement.
 */
export function refreshDeviceTier(next: { override?: TierOverride; measured?: boolean } = {}): Tier {
  if (next.override !== undefined) override = next.override;
  if (next.measured !== undefined) measured = next.measured;
  const resolved = resolveTier(readSignals(), override, measured);
  if (resolved !== current) {
    current = resolved;
    for (const listener of listeners) listener();
  }
  return resolved;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The tier, re-rendering when it changes. */
export function useDeviceTier(): Tier {
  return useSyncExternalStore(subscribe, deviceTier, deviceTier);
}
