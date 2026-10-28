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
    translationRootMargin: "600px 0px 600px 0px",
    translationAtIdle: false,
    measureDebounceMs: 150,
    notesPollMs: 120_000,
    animations: true,
  },
  low: {
    windowing: true,
    rowsPerChunk: 24,
    mountRootMargin: "150% 0px 150% 0px",
    keepRootMargin: "250% 0px 250% 0px",
    initialChunks: 2,
    chapterCacheEntries: 12,
    chapterCacheChars: 2_000_000,
    knownChapters: 5,
    translationCacheEntries: 12,
    translationCacheChars: 600_000,
    translationInFlight: 1,
    translationRootMargin: "600px 0px 600px 0px",
    translationAtIdle: true,
    measureDebounceMs: 250,
    notesPollMs: 0,
    animations: false,
  },
};

/**
 * The tier for these signals, the reader's override and whether long frames were measured on this device.
 * Pure, so it is tested without a browser. A fine pointer on a wide screen is the desktop, whatever its memory, and takes
 * no measured promotion. Override On is low everywhere; Off keeps the desktop as it is and makes every other device normal.
 */
export function resolveTier(signals: TierSignals, override: TierOverride, measured: boolean): Tier {
  const desktop = signals.finePointer && signals.wideViewport;
  if (override === "on") return "low";
  if (override === "off") return desktop ? "desktop" : "normal";
  if (desktop) return "desktop";
  return measured || lowFromDevice(signals) ? "low" : "normal";
}

/**
 * Low-end by what the device reports: Save-Data, 2 GiB of memory or less, or four cores or fewer on a touch screen when
 * no memory figure exists. "Touch screen" is read as no fine pointer, since TierSignals carries no coarse flag.
 */
function lowFromDevice(signals: TierSignals): boolean {
  if (signals.saveData) return true;
  if (typeof signals.deviceMemory === "number") return signals.deviceMemory <= 2;
  return !signals.finePointer && typeof signals.hardwareConcurrency === "number" && signals.hardwareConcurrency <= 4;
}

/** The signals as this browser reports them; safe where there is no window (tests, the server build). */
export function readSignals(): TierSignals {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { finePointer: true, wideViewport: true, saveData: false };
  }
  const nav = (typeof navigator === "undefined" ? {} : navigator) as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return {
    finePointer: window.matchMedia("(pointer: fine)").matches,
    wideViewport: window.matchMedia("(min-width: 72rem)").matches,
    ...(typeof nav.deviceMemory === "number" ? { deviceMemory: nav.deviceMemory } : {}),
    ...(typeof nav.hardwareConcurrency === "number" ? { hardwareConcurrency: nav.hardwareConcurrency } : {}),
    saveData: nav.connection?.saveData === true || window.matchMedia("(prefers-reduced-data: reduce)").matches,
  };
}

// The key an earlier build kept a measurement under. It is removed once per page and never written again.
const STORE_KEY = "deepread.deviceTier";
// The long-frame measurement, counted over the whole session on a book page: frames of FRAME_MS or more that start more
// than SETTLE_MS after the chapter appears. FRAMES_TO_MEASURE of them, or one frame of BIG_FRAME_MS or more, promote the
// device to low for this page session only. These describe the measurement, not the reader, so they stay here, not in TIER_PARAMS.
const SETTLE_MS = 2_000;
const FRAME_MS = 100;
const BIG_FRAME_MS = 400;
const FRAMES_TO_MEASURE = 5;
const WAIT_FOR_CHAPTER_MS = 10_000;

let override: TierOverride = "auto";
let measured = false;
let current: Tier | null = null;
let wired = false;
let armed = false;
const listeners = new Set<() => void>();

/** The tier now, resolved on first use. */
export function deviceTier(): Tier {
  wire();
  current ??= resolveTier(readSignals(), override, measured);
  return current;
}

/** The parameters for the tier now. */
export function tierParams(): TierParams {
  return TIER_PARAMS[deviceTier()];
}

/**
 * Resolves the tier again with a new override or measurement, and tells `useDeviceTier` readers when it changed. The reader
 * calls this from the setting, from its page on mount, and from the measurement. A change of the media queries re-resolves
 * the tier too, but never arms the measurement.
 */
export function refreshDeviceTier(next: { override?: TierOverride; measured?: boolean } = {}): Tier {
  return refresh(next, true);
}

function refresh(next: { override?: TierOverride; measured?: boolean }, arming: boolean): Tier {
  wire();
  if (next.override !== undefined && next.override !== override) {
    override = next.override;
    // A measurement belongs to the override it was made under, so a new choice forgets it.
    measured = false;
  }
  if (next.measured !== undefined) measured = next.measured;
  if (arming) arm();
  const resolved = resolveTier(readSignals(), override, measured);
  if (resolved !== current) {
    current = resolved;
    // The stylesheet reads this attribute, so a change made after the first paint (a measurement, a window crossing a breakpoint) must reach it too.
    const root = typeof document === "undefined" ? undefined : document.documentElement;
    if (root?.dataset) root.dataset.tier = resolved;
    for (const listener of listeners) listener();
  }
  return resolved;
}

/**
 * Once per page: removes a record an earlier build kept (a measurement lasts this page session only), and re-resolves
 * when the two media queries the tier depends on change. Storage and window may be missing.
 */
function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  forget();
  if (typeof window.matchMedia !== "function") return;
  for (const query of ["(pointer: fine)", "(min-width: 72rem)"]) {
    const list = window.matchMedia(query);
    if (typeof list.addEventListener === "function") list.addEventListener("change", () => refresh({}, false));
  }
}

function forget(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing to forget where storage is blocked.
  }
}

/**
 * Starts the measurement once per page, on a book page in Auto mode, for a phone that is neither desktop nor low by its
 * signals. It waits for the first chapter to appear, for up to WAIT_FOR_CHAPTER_MS, and then measures.
 */
function arm(): void {
  if (armed || typeof window === "undefined" || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  if (override !== "auto" || measured || window.location?.pathname?.startsWith("/book/") !== true) return;
  const signals = readSignals();
  if ((signals.finePointer && signals.wideViewport) || lowFromDevice(signals)) return;
  armed = true;
  if (document.querySelector("[data-chapter]") !== null) {
    measure(performance.now());
    return;
  }
  const watch = new MutationObserver(() => {
    if (document.querySelector("[data-chapter]") === null) return;
    watch.disconnect();
    clearTimeout(giveUp);
    measure(performance.now());
  });
  const giveUp = setTimeout(() => watch.disconnect(), WAIT_FOR_CHAPTER_MS);
  watch.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
}

/**
 * Counts long frames for the whole session on a book page, from the first chapter on. One frame of BIG_FRAME_MS or more
 * promotes the device at once; FRAMES_TO_MEASURE frames of FRAME_MS or more promote it too. Frames in the first
 * SETTLE_MS are loading noise and are not counted.
 */
function measure(chapterAt: number): void {
  if (typeof PerformanceObserver === "undefined") return;
  const type = PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") ? "long-animation-frame" : "longtask";
  let frames = 0;
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      if (override !== "auto" || window.location?.pathname?.startsWith("/book/") !== true) return;
      let promote = false;
      for (const entry of list.getEntries()) {
        if (entry.startTime - chapterAt <= SETTLE_MS) continue;
        if (entry.duration >= BIG_FRAME_MS) promote = true;
        else if (entry.duration >= FRAME_MS) frames += 1;
      }
      if (!promote && frames < FRAMES_TO_MEASURE) return;
      observer?.disconnect();
      refreshDeviceTier({ measured: true });
    });
    observer.observe({ type, buffered: false });
  } catch {
    // Not supported on this browser: the tier stays what the other signals gave.
    observer?.disconnect();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The tier, re-rendering when it changes. */
export function useDeviceTier(): Tier {
  return useSyncExternalStore(subscribe, deviceTier, deviceTier);
}
