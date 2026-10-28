// Keeps a chapter's text chunks on the page as rows only near the reader: far chunks are placeholders of their measured
// (or, before that, estimated) height, so a long chapter costs what is near the reader, not all of it.
// Mounting is decided by two intersection observers (a mount margin and a wider keep margin, so a chunk at the edge does
// not flap), by pins (chunks a feature is using, see mountRegistry.ts) and by note cards (never unmounted: they stream and
// fold). Heights come from a ResizeObserver, never from reading layout in a loop. Whatever changes heights above the
// reader (a text size, font, width or translation change) is applied with the row at the eye line held still.
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { TierParams } from "../deviceTier.ts";
import { indexAtLine } from "./book.ts";
import {
  calibrate,
  carriedMounted,
  charsOf,
  type Chunk,
  ChunkHeights,
  chunkKeys,
  defaultCalibration,
  epochOf,
  estimateHeight,
  type HeightSample,
  initialMounted,
  sameSet,
  windowOf,
} from "./chunkWindow.ts";
import { bumpMounts, pinnedBlocks, registerWindow, subscribePins } from "./mountRegistry.ts";
import { eyeLine } from "./useReadingPosition.ts";

export type ChunkWindow = {
  /** The chunks showing their rows; "all" when windowing is off (the desktop tier), where every chunk does. */
  mounted: ReadonlySet<string> | "all";
  /** The height a placeholder takes: measured in this epoch, else estimated. */
  heightFor: (chunk: Chunk) => number;
  /** The ref for a chunk's element, the same function each render so React attaches it once. */
  chunkRef: (key: string) => (element: HTMLDivElement | null) => () => void;
};

type Options = {
  container: RefObject<HTMLDivElement | null>;
  bookId: string;
  chapterId: string;
  chunks: readonly Chunk[];
  /** Chunks holding a question note card: always mounted, so the card keeps its answer and its fold. */
  noteChunks: ReadonlySet<string>;
  params: TierParams;
  /** The block the chapter opens at (the saved place), so its chunk renders before the observers report. */
  openAt?: string;
  /** Translations are shown under the rows, which changes every height. */
  translated: boolean;
};

/** The typography attributes on the root that reflow the book (prefs.ts). */
const TYPOGRAPHY_ATTRIBUTES = ["data-font", "data-spacing", "data-margins", "data-align", "data-layout"];

/** A chunk mounted on request (ensureMounted) stays this long before the observers may drop it again. */
const GRACE_MS = 1500;

// Heights survive a chapter leaving the page: when it comes back, its placeholders have their real sizes at once.
const heights = new ChunkHeights();
// The measured chunks each epoch of a chapter has seen, for estimating the ones it has not: kept for a few epochs, so a
// width or text size the reader returns to (a rotation, a tap back) gives the same estimates as before.
const samplesByEpoch = new Map<string, Map<string, HeightSample>>();
const SAMPLE_EPOCHS = 12;

function samplesFor(chapterKey: string, epoch: string): Map<string, HeightSample> {
  const key = `${chapterKey}|${epoch}`;
  let samples = samplesByEpoch.get(key);
  if (samples) {
    samplesByEpoch.delete(key);
  } else {
    samples = new Map();
    while (samplesByEpoch.size >= SAMPLE_EPOCHS) {
      const oldest = samplesByEpoch.keys().next().value;
      if (oldest === undefined) break;
      samplesByEpoch.delete(oldest);
    }
  }
  samplesByEpoch.set(key, samples);
  return samples;
}

/** The row (or chapter head or placeholder) at the reader's eye line, anywhere on the page. */
function rowAtEyeLine(): HTMLElement | null {
  const sections = document.querySelectorAll<HTMLElement>(".chapter-head, .chapter-text > .text-chunk");
  if (sections.length === 0) return null;
  const line = eyeLine();
  const at = indexAtLine(sections.length, (index) => sections[index]!.getBoundingClientRect().bottom, line);
  const section = sections[Math.min(at, sections.length - 1)]!;
  const rows = section.querySelectorAll<HTMLElement>(":scope > .row");
  if (rows.length === 0) return section;
  const rowAt = indexAtLine(rows.length, (index) => rows[index]!.getBoundingClientRect().bottom, line);
  return rows[Math.min(rowAt, rows.length - 1)] ?? section;
}

/** The block at the eye line (found again by id when a rechunking rebuilds its element), where it was, and the anchoring setting to give back. */
type HeldRow = { element: HTMLElement; id: string; top: number; previous: string } | null;

/**
 * Notes where the row at the reader's eye line is and turns the browser's own anchoring off, as in keepInPlace
 * (useChapterFlow.ts): where it acts it would move the text a second time. `releaseRow` scrolls by what moved the row.
 */
function holdRow(): HeldRow {
  const row = rowAtEyeLine();
  if (!row) return null;
  const element = row.querySelector<HTMLElement>("[data-block]") ?? row;
  const root = document.documentElement;
  const previous = root.style.overflowAnchor;
  root.style.overflowAnchor = "none";
  return { element, id: element.id, top: element.getBoundingClientRect().top, previous };
}

/** Scrolls by what moved the held row since `holdRow`, so the line being read stays where it is, and gives anchoring back. */
function releaseRow(held: HeldRow): void {
  if (!held) return;
  const element = held.element.isConnected ? held.element : held.id ? document.getElementById(held.id) : null;
  if (element) window.scrollBy({ top: element.getBoundingClientRect().top - held.top, behavior: "instant" });
  const root = document.documentElement;
  if (held.previous !== "none") {
    requestAnimationFrame(() => {
      if (root.style.overflowAnchor === "none") root.style.overflowAnchor = held.previous;
    });
  }
}

/** Runs `change`, which moves things above the reader (placeholders changing size, chunks mounting), with the row at the eye line held still. */
function keepingRow(change: () => void): void {
  const held = holdRow();
  change();
  releaseRow(held);
}

/** Whether the browser keeps the text in view still by itself when something above it changes size. */
const anchorsScroll = (): boolean => typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");

const typographySignature = (): string => {
  const root = document.documentElement;
  return epochOf([...TYPOGRAPHY_ATTRIBUTES.map((attribute) => root.getAttribute(attribute)), root.style.getPropertyValue("--book-size")]);
};

type Layout = { signature: string; width: number; fontSize: number; lineHeight: number };

const DEFAULT_LAYOUT: Layout = { signature: "", width: 360, fontSize: 19, lineHeight: 30 };

/** The column as the page already has it (another chapter's text), so a chapter arriving above the reader starts with real estimates. */
function initialLayout(): Layout {
  if (typeof document === "undefined") return DEFAULT_LAYOUT;
  const column = document.querySelector<HTMLElement>(".chapter-text");
  if (!column) return { ...DEFAULT_LAYOUT, signature: typographySignature() };
  const style = getComputedStyle(column);
  const fontSize = parseFloat(style.fontSize) || DEFAULT_LAYOUT.fontSize;
  return { signature: typographySignature(), width: column.getBoundingClientRect().width || DEFAULT_LAYOUT.width, fontSize, lineHeight: parseFloat(style.lineHeight) || fontSize * 1.6 };
}

export function useChunkWindow({ container, bookId, chapterId, chunks, noteChunks, params, openAt, translated }: Options): ChunkWindow {
  const { windowing } = params;
  const keyOf = useMemo(() => chunkKeys(chunks), [chunks]);
  // What opens as rows: the first chunks, the saved place's, and every chunk with a note card (never a placeholder).
  const opening = (): Set<string> => {
    if (!windowing) return new Set();
    const set = initialMounted(chunks, params.initialChunks, openAt);
    for (const key of noteChunks) set.add(key);
    return set;
  };
  const [mounted, setMounted] = useState<Set<string>>(opening);
  const [layout, setLayout] = useState<Layout>(() => (windowing ? initialLayout() : DEFAULT_LAYOUT));
  const epoch = epochOf([layout.signature, layout.width, translated, params.rowsPerChunk]);

  // Read by observer callbacks, which must see the latest without being recreated.
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;
  const noteChunksRef = useRef(noteChunks);
  noteChunksRef.current = noteChunks;
  const near = useRef(new Set<string>());
  const kept = useRef(new Set<string>());
  // Chunks the keep observer has reported at all: one mounted before it has (the opening set, a mount on request, a
  // rechunking) counts as kept until it says otherwise, so nothing is evicted before the observers have spoken.
  const reported = useRef(new Set<string>());
  // The row at the eye line across a rechunking: held while rendering, released in a layout effect after the commit.
  const held = useRef<HeldRow>(null);
  // Pins of this chapter's own: the selection's ends and the focused row, besides what the registry pins.
  const local = useRef(new Set<string>());
  const grace = useRef(new Map<string, number>());
  const chapterKey = `${bookId}:${chapterId}`;
  const heightKey = useCallback((key: string) => `${chapterKey}:${key}`, [chapterKey]);
  // Measured in this epoch, for calibrating the estimates of chunks not measured yet.
  const samples = useRef<{ epoch: string; byKey: Map<string, HeightSample> }>({ epoch: "", byKey: new Map() });
  if (samples.current.epoch !== epoch) samples.current = { epoch, byKey: samplesFor(chapterKey, epoch) };

  /** Takes `next` as the mounted set. A chunk mounting gets a new element, which the keep observer has not reported yet. */
  const adopt = useCallback((next: Set<string>): void => {
    for (const key of next) if (!mountedRef.current.has(key)) reported.current.delete(key);
    mountedRef.current = next;
  }, []);

  /** The chunks that should show rows now, and the commit that gets there, with the eye line held where needed. */
  const recompute = useCallback(() => {
    if (!windowing || !alive.current) return;
    const now = performance.now();
    for (const [key, until] of grace.current) if (until <= now) grace.current.delete(key);
    const pinned = new Set<string>([...local.current, ...grace.current.keys(), ...noteChunksRef.current]);
    for (const blockId of pinnedBlocks(chapterId)) {
      const key = keyOf.get(blockId);
      if (key) pinned.add(key);
    }
    const previous = mountedRef.current;
    const next = windowOf(chunksRef.current, { mounted: previous, near: near.current, kept: kept.current, pinned, reported: reported.current });
    if (sameSet(next, previous)) return;
    const mounting = [...next].filter((key) => !previous.has(key));
    // Where the browser does not anchor the scroll itself, a chunk growing from a placeholder above the reader is
    // mounted with the row at the eye line held still.
    const mountsAbove = !anchorsScroll() && mounting.some((key) => {
      const element = container.current?.querySelector<HTMLElement>(`[data-chunk="${CSS.escape(key)}"]`);
      return element !== null && element !== undefined && element.getBoundingClientRect().bottom < eyeLine();
    });
    adopt(next);
    if (mountsAbove) keepingRow(() => flushSync(() => setMounted(next)));
    else if (mounting.length === 0) startTransition(() => setMounted(next));
    else setMounted(next);
  }, [windowing, chapterId, keyOf, container, adopt]);
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // Notes arrive after the chapter opens: the chunk under a new card mounts so the card is never inside a placeholder.
  useEffect(() => {
    recomputeRef.current();
  }, [noteChunks]);

  // Observers, made once the first chunk element is on the page; one set for the chapter, every chunk a target.
  const observers = useRef<{ near: IntersectionObserver; keep: IntersectionObserver; size: ResizeObserver } | null>(null);
  const observe = useCallback((): NonNullable<typeof observers.current> | null => {
    if (!windowing || typeof IntersectionObserver === "undefined" || typeof ResizeObserver === "undefined") return null;
    observers.current ??= (() => {
      const track = (set: Set<string>, seen?: Set<string>) => (entries: IntersectionObserverEntry[]) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.chunk;
          if (!key) continue;
          seen?.add(key);
          if (entry.isIntersecting) set.add(key);
          else set.delete(key);
        }
        recomputeRef.current();
      };
      const size = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          const key = element.dataset.chunk;
          // A placeholder's size is what we gave it, not a measurement.
          if (!key || element.dataset.placeholder !== undefined) continue;
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (!Number.isFinite(height) || height <= 0) continue;
          heights.remember(heightKey(key), epochRef.current, height);
          const chunk = chunksRef.current.find((item) => item.key === key);
          if (chunk) samples.current.byKey.set(key, { chars: charsOf(chunk.blocks), blocks: chunk.blocks.length, height });
        }
      });
      return {
        near: new IntersectionObserver(track(near.current), { rootMargin: params.mountRootMargin }),
        keep: new IntersectionObserver(track(kept.current, reported.current), { rootMargin: params.keepRootMargin }),
        size,
      };
    })();
    return observers.current;
  }, [windowing, params.mountRootMargin, params.keepRootMargin, heightKey]);

  const refs = useRef(new Map<string, (element: HTMLDivElement | null) => () => void>());
  const chunkRef = useCallback(
    (key: string) => {
      let ref = refs.current.get(key);
      if (!ref) {
        ref = (element) => {
          const set = element ? observe() : null;
          if (element && set) {
            set.near.observe(element);
            set.keep.observe(element);
            set.size.observe(element);
          }
          return () => {
            if (!element || !set) return;
            set.near.unobserve(element);
            set.keep.unobserve(element);
            set.size.unobserve(element);
            // A placeholder becoming rows (or back) passes here too, its element replaced: while the key stays mounted
            // its reports stay with it, so the swap never reads as the observers having dropped the chunk.
            if (mountedRef.current.has(key)) return;
            near.current.delete(key);
            kept.current.delete(key);
            reported.current.delete(key);
          };
        };
        refs.current.set(key, ref);
      }
      return ref;
    },
    [observe],
  );

  // A tier or chapter change rechunks the rows. Handled while rendering, before the commit: the rows around the reader
  // are carried over by block id, so the commit shows them as rows, and the row at the eye line is held where the reader
  // saw it, so the commit can be corrected for the far placeholders changing height. The observers start over on the
  // new elements, which they report before anything is evicted.
  const chunkingRef = useRef({ chunks, rowsPerChunk: params.rowsPerChunk, windowing });
  const chunking = chunkingRef.current;
  if (chunking.chunks !== chunks || chunking.rowsPerChunk !== params.rowsPerChunk || chunking.windowing !== windowing) {
    chunkingRef.current = { chunks, rowsPerChunk: params.rowsPerChunk, windowing };
    observers.current?.near.disconnect();
    observers.current?.keep.disconnect();
    observers.current?.size.disconnect();
    observers.current = null;
    refs.current.clear();
    near.current.clear();
    kept.current.clear();
    reported.current.clear();
    let next = new Set<string>();
    if (windowing) {
      held.current ??= holdRow();
      // Without windowing every chunk was rows.
      const was = chunking.windowing ? mountedRef.current : new Set(chunking.chunks.map((chunk) => chunk.key));
      next = carriedMounted(chunking.chunks, was, keyOf);
      for (const key of noteChunks) next.add(key);
      if (next.size === 0) next = opening();
    }
    mountedRef.current = next;
    setMounted(next);
  }

  // The correction for a rechunking, once its rows are on the page: flushSync is not allowed inside a layout effect,
  // so the hold spans the commit instead of wrapping a flush.
  useLayoutEffect(() => {
    if (!held.current) return;
    releaseRow(held.current);
    held.current = null;
  });

  useEffect(
    () => () => {
      observers.current?.near.disconnect();
      observers.current?.keep.disconnect();
      observers.current?.size.disconnect();
      observers.current = null;
    },
    [],
  );

  // Features that bring a block onto the page (a search result, the voice, Back) mount its chunk through the registry.
  useEffect(() => {
    if (!windowing) return registerWindow(chapterId, (blockId) => keyOf.has(blockId));
    return registerWindow(chapterId, (blockId) => {
      const key = keyOf.get(blockId);
      if (!key) return false;
      grace.current.set(key, performance.now() + GRACE_MS);
      window.setTimeout(() => recomputeRef.current(), GRACE_MS + 50);
      if (!mountedRef.current.has(key)) {
        const next = new Set(mountedRef.current);
        next.add(key);
        adopt(next);
        setMounted(next);
      }
      return true;
    });
  }, [windowing, chapterId, keyOf, adopt]);

  useEffect(() => (windowing ? subscribePins(() => recomputeRef.current()) : undefined), [windowing]);

  // Pins of this chapter's own: the chunk under a selection's ends, and the chunk holding the focused row.
  useEffect(() => {
    const element = container.current;
    if (!windowing || !element) return;
    const keyOfNode = (node: Node | null): string | undefined => {
      const target = node instanceof Element ? node : node?.parentElement;
      const chunk = target?.closest<HTMLElement>(".text-chunk");
      return chunk && element.contains(chunk) ? chunk.dataset.chunk : undefined;
    };
    let focused: string | undefined;
    let selected: string[] = [];
    const apply = () => {
      const next = new Set<string>([...selected, ...(focused ? [focused] : [])]);
      if (sameSet(next, local.current)) return;
      local.current = next;
      recomputeRef.current();
    };
    const onFocusIn = (event: FocusEvent) => {
      focused = keyOfNode(event.target as Node);
      apply();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (keyOfNode(event.relatedTarget as Node | null) === undefined) focused = undefined;
      apply();
    };
    const onSelectionChange = () => {
      const selection = document.getSelection();
      const keys = selection && !selection.isCollapsed ? [keyOfNode(selection.anchorNode), keyOfNode(selection.focusNode)] : [];
      selected = keys.filter((key): key is string => key !== undefined);
      apply();
    };
    element.addEventListener("focusin", onFocusIn);
    element.addEventListener("focusout", onFocusOut);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("selectionchange", onSelectionChange);
      local.current = new Set();
    };
  }, [windowing, container]);

  // The column's width and the typography: each change starts a new epoch of heights, applied with the row at the eye
  // line held still, since placeholders above it change size. A font arriving (the book's, a translation's script) keeps
  // the epoch: the size observer re-measures the mounted chunks under it, so only the placeholders are re-estimated and
  // the eye line corrected.
  useLayoutEffect(() => {
    const element = container.current;
    if (!windowing || !element || typeof ResizeObserver === "undefined") return;
    const measureLayout = (): Pick<Layout, "fontSize" | "lineHeight"> => {
      const style = getComputedStyle(element);
      const fontSize = parseFloat(style.fontSize) || DEFAULT_LAYOUT.fontSize;
      const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.6;
      return { fontSize, lineHeight };
    };
    const update = (patch: Partial<Layout>) => {
      keepingRow(() => flushSync(() => setLayout((current) => ({ ...current, ...patch }))));
    };
    let width = element.getBoundingClientRect().width;
    let signature = typographySignature();
    // Synchronous, inside the commit: a chapter put above the reader (keepInPlace) is measured before its correction.
    const measured = measureLayout();
    setLayout((current) =>
      current.width === width && current.signature === signature && current.fontSize === measured.fontSize && current.lineHeight === measured.lineHeight
        ? current
        : { ...current, width, signature, ...measured },
    );
    const resized = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      update({ width });
    });
    resized.observe(element);
    const changed = new MutationObserver(() => {
      const next = typographySignature();
      if (next === signature) return;
      signature = next;
      update({ signature, ...measureLayout() });
    });
    changed.observe(document.documentElement, { attributes: true, attributeFilter: [...TYPOGRAPHY_ATTRIBUTES, "style"] });
    const loaded = () => update(measureLayout());
    document.fonts?.addEventListener("loadingdone", loaded);
    return () => {
      resized.disconnect();
      changed.disconnect();
      document.fonts?.removeEventListener("loadingdone", loaded);
    };
  }, [windowing, container]);

  // A new epoch measures every mounted chunk again: the size observer reports changes only, and a chunk whose size the
  // change left alone would otherwise have no height in the epoch, and get an estimate when it unmounts.
  const measuredEpoch = useRef(epoch);
  useLayoutEffect(() => {
    if (measuredEpoch.current === epoch) return;
    measuredEpoch.current = epoch;
    const size = observers.current?.size;
    const element = container.current;
    if (!size || !element) return;
    for (const chunk of element.querySelectorAll<HTMLElement>(".text-chunk[data-chunk]:not([data-placeholder])")) {
      size.unobserve(chunk);
      size.observe(chunk);
    }
  }, [epoch, container]);

  // Marks and highlights painted on rows repaint once the rows have come or gone.
  useEffect(() => {
    if (windowing) bumpMounts();
  }, [windowing, mounted]);

  const heightFor = useCallback(
    (chunk: Chunk): number => {
      const known = heights.get(heightKey(chunk.key), epoch);
      if (known !== undefined) return known;
      const fallback = defaultCalibration(layout.fontSize, layout.lineHeight, layout.width);
      const calibration = calibrate([...samples.current.byKey.values()], fallback);
      // Translations roughly double a row; estimated from the source alone until a translated chunk is measured.
      const estimated = estimateHeight(chunk.blocks, calibration, layout.width);
      return translated && samples.current.byKey.size === 0 ? estimated * 2 : estimated;
    },
    [heightKey, epoch, layout, translated],
  );

  return { mounted: windowing ? mounted : "all", heightFor, chunkRef };
}
