# Large illustrated books on mobile

## Evidence and scope

The owner reports slow opening and scrolling for large, illustrated books on a weaker phone. Normal reading fetches chapter JSON and summaries, not the original PDF. File size alone is therefore an unreliable proxy: extracted image pixels, paragraph count, and retained chapters drive client work. The owner's private book cannot be inspected without access; verification uses an isolated illustrated fixture.

Four concrete costs were found:

- A figure excluded its entire 48-row group from mobile content visibility.
- The reader always requested the full extracted PNG, even for a small phone display.
- Concurrent metadata and chapter requests could download and parse the same book.json twice.
- Opening another book waited for an unrelated progress save, up to two seconds.

## Architecture

Keep canonical text, IDs and offsets intact. Split figures into individual rendering groups, with prose groups capped at 48 rows. Valid figure dimensions establish an explicit CSS width and aspect ratio before decoding. These groups can safely use the existing measured-height mobile containment; notes and unknown-size figures retain ordinary layout. Desktop and Pages layout preserve their existing layout path.

Use native lazy loading and responsive image selection. Advertise downsampled widths 480, 960 and 1440 only below the original width, plus the original at its real width. Lazy images use sizes=auto with a fallback for older browsers. Explicit CSS sizing keeps smaller source variants from changing image placement or dimensions.

The existing authenticated figure route accepts only those three widths. PNG resizing preserves transparency and does not upscale. A shared variant service deduplicates work, limits concurrent resizing to two, queues at most 16 distinct jobs, caps input bytes across active and queued jobs at 16 MB, and caps retained output bytes at 8 MB/64 entries. Ordinary image request bursts wait for a resize slot. Current library access is checked before each cache lookup. Queue/input budget overflow or decoding failure returns the original, keeping illustrations readable. No reimport or storage migration is needed.

Position tracking searches rendering group wrappers before source text geometry. Inside a figure-only group it locates the following source block through DOM queries, avoiding binary geometry probes into distant skipped prose.

Share in-flight parsed-book loads between metadata/chapter requests, with retry and deletion invalidation. Track progress saves by book; same-book reads and shelf refreshes keep their consistency wait, while unrelated books open immediately.

## Alternatives and limits

Full DOM virtualization could bound retained chapter memory, but also changes cross-chapter selection, browser find, speech, highlights, navigation and anchor restoration. It requires a separate coordinated design rather than replacing the current renderer inside this fix. Loaded chapters still accumulate; content visibility limits rendering, not all DOM/data memory.

Importer changes would not fix existing books and are outside this performance work. Rewriting text would also invalidate source offsets. Responsive assets and the reader improvements apply directly to stored books.

On a 2000 x 1500 figure, a 480 x 360 representation reduces decoded pixel storage from approximately 12 MB to 0.69 MB. Browser density and display size determine the actual selected variant; server fallback under saturation can still serve the full original. This is not a claim that every physical phone will meet a fixed frame rate.

## Focused verification

Focused unit tests cover rendering order and heading indices around images, aspect-ratio/source candidates, static figure containment, figure-only source tracking, image downsampling/transparency/access checks/bounds, shared book loading/retry/deletion, and per-book progress-save waits.

The illustrated-mobile browser fixture has 600 paragraphs, 50 figures, full-page translation, and CPU throttling, with density checks at DPR 1 and DPR 2. Check reserved image size before/after decode, small source selection, distant image deferral and containment, selection, phone widths, and Pages/Scroll transitions. Existing pdf-content and translation-mobile journeys cover source-image overlays, highlights, translations and scroll anchors. Typecheck and build complete validation; never run the full test suite.
