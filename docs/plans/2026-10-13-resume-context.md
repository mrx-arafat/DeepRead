# Resume reminder spacing and fetching

The screenshot identifies the Continue footer in the Where I left off dialog. Its message and button had zero separation because the global action row supplies horizontal gaps but no top margin. Add 1.25rem only to this dialog's action row; existing touch target sizing and other dialogs remain unchanged.

The reminder previously fetched the entire saved chapter and all book notes concurrently, then computed a short excerpt in the browser. For a large chapter this transfers and parses content that the dialog never displays.

Move the existing pure resumeText calculation into shared code and expose a read-only, authenticated resume endpoint. The request contains the saved source chapter/block/offset. The response contains only chapter identity/title, the existing excerpt (up to 600 characters), nearest preceding highlight (up to 280 characters plus truncation marker), and note retry status. Existing source IDs and offsets remain intact.

Both book and notes reads must authorize access before any excerpt is returned. A missing book, unavailable shared notes, authentication failure or closed library denies the request; ordinary note storage failures retain the excerpt with the existing retry message. Do not publish an early chapter result before authorization finishes. Strictly validate the requested anchor. No reading progress or source text is changed.

Keep Continue's generic book URL so opening the reader still resolves the latest server progress, including cross-device changes. Preserve View highlight detour and return position semantics.

Focused verification covers bounded response size with a large chapter/note fixture, concurrent server reads, access loss, closed-library races, note failures, source offsets, client cancellation/errors, and the existing resumeText cases. Browser checks cover 20px spacing, 44px touch targets, 320/390/1280px widths, a scrollable footer, close/focus, retry, and unchanged progress. Run typecheck and build, never the full test suite.
