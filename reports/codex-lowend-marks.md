# cx-marks handoff

Branch: `perf/lowend-marks`.
Base: `96906b374affa1ab3f0459a6cdb6b08d48321a08`.

## Files and changes

- `src/reader/textRanges.ts`: `rangeInBlock` uses `blockElement` from the mount registry, preserving its id lookup and legacy `data-block` fallback, and returns null when no block is mounted.
- `src/reader/useNoteMarks.ts`: both paint effects depend on `useMountVersion()`, releasing previous ranges and repainting mounted note passages and colored highlights after chunk changes.
- `src/reader/domText.test.ts`: completes the existing document fixture with `getElementById`, retaining coverage of the legacy attribute fallback and inline text ranges.
- `src/reader/domText.ts`: inspected; no change needed.

No new logic requiring a separate test file was introduced.
No public documentation impact.
The registry and tier files were not edited.

## Verification

- `pnpm exec vitest run src/reader/domText.test.ts src/reader/textRanges.test.ts --reporter=dot`: passed, 2 files and 41 tests.
- `pnpm typecheck`: passed.
- `git diff --check`: passed.
- Browser verification intentionally not run, per assignment.

## Browser owner checks

1. On a phone tier, scroll a highlighted passage out of the mounted window and back; confirm its colored highlight returns and detached ranges are released.
2. Confirm question-note passage marks and active hover/focus marks repaint after chunk mount changes.
3. Confirm desktop note and highlight painting remains unchanged, including legacy blocks with only `data-block` attributes and chapter titles found by id.

The design report was found in the shared fleet `reports/w2-design.md`; sections 3.4 and 6 were consulted alongside the base registry and tier APIs.
