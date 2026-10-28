# cx-listen handoff

Branch: `perf/lowend-listen`, based on `96906b374affa1ab3f0459a6cdb6b08d48321a08`.

## Files and behavior

- `src/reader/useListen.ts`: resolves block ownership from the existing chapter-title entries in the ordered speech data, falling back to the mounted block's article when those entries are absent.
  Pins current and next sentence blocks for the active player, including while paused, and clears pins on stop and effect cleanup.
  Mounts targets before sentence painting, automatic scrolling, explicit reveal, and eye-line sentence measurement.
  Repaints sentence ranges on mount-version changes without restarting speech.
- `src/reader/useWordCursor.ts`: accepts an optional third argument `{ chapterId, blockIds }` containing ordered readable block IDs.
  Uses that order to mount and focus adjacent blocks, retaining the existing DOM fallback when the argument is absent.
- Both existing hook test files: focused coverage for current/next cross-chapter pins and release, mounting, and keyboard movement in both directions when the target is absent from DOM siblings.

## Required integration in slice B

`ChapterText.tsx` is outside this worker's allowed files.
Its caller must supply the third argument for navigation across evicted chunks:

```tsx
useWordCursor(firstBlockId, onAsk, {
  chapterId,
  blockIds: blocks.filter((block) => block.type !== "image" && block.text.trim()).map((block) => block.id),
});
```

Memoize the readable ID list with the chapter blocks in the caller.
Until this is wired, the hook preserves existing DOM navigation and cannot traverse an evicted chunk.
No `mountRegistry.ts`, `deviceTier.ts`, or caller files were edited.

## Verification

- `pnpm exec vitest run src/reader/useListen.test.ts src/reader/useWordCursor.test.ts --reporter=dot`: 2 files, 4 tests passed.
- `pnpm typecheck`: exit 0.
- No browser or push, as required.
- No public documentation impact; this report records the internal hook contract.

## Browser owner checks

1. Supply the ordered IDs in slice B, then arrow forward/backward across an evicted chunk and check focus and word highlight.
2. Listen across a chunk and chapter boundary; current and next blocks must remain mounted while scrolling away or pausing.
3. Use Show sentence after scrolling away, then Stop and confirm the listen pins release.
4. Confirm desktop scrolling and page-turn behavior remains unchanged.
