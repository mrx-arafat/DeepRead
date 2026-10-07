# DeepRead roadmap and handover

This file is for the next developer.
It says what was just built, what is left, in what order, and how to do each part.

## Where things stand

The reader and the library were redesigned to feel like a calm e-reader.
The historical shipped sections describe the existing baseline. The implementation checkpoint below distinguishes new local work from committed releases and broader acceptance still to verify.

| Area | What it does | Main files |
| --- | --- | --- |
| Page settings | Light, sepia and dark themes; Literata or Atkinson; text size slider; line spacing; margins; justified text; Scroll or Pages layout | `src/prefs.ts`, `src/reader/ReadingSettings.tsx`, theme tokens at the top of `src/styles.css` |
| Chapter openings and footer | Centred small-caps chapter titles; a footer with minutes (Scroll) or pages (Pages) left in the chapter | `src/reader/ChapterSection.tsx`, `src/reader/ReaderPage.tsx`, `chapterMinutesLeft` in `src/reader/book.ts` |
| Pages mode | Turns a screen at a time by key, wheel, swipe or a press in the margin; never shows a cut line; the top bar hides while reading | `src/reader/paging.ts` (pure maths, unit tested), `src/reader/usePages.ts`, the `data-layout="pages"` rules in `src/styles.css` |
| Library shelf | Generated cloth covers, a Continue reading card, progress under each book, a More actions menu, an edit dialog, drop a PDF anywhere | `src/LibraryPage.tsx`, `src/library/*` |
| Storage | Books (PDF, parsed text, cover, answer cache) and notes are kept in an object store: the data folder by default, or a Cloudflare R2 bucket; an optional size limit refuses uploads that would pass it, and the library page shows the space used; `pnpm storage:migrate` copies a local library into R2 | `server/storage.ts`, `server/storage-r2.ts`, `server/storage-config.ts`, `server/env.ts`, `server/library.ts`, `shared/notes.ts`, `src/reader/noteSync.ts`, `scripts/storage-migrate.ts`, `.env.example` |

Notes now live with the book on the server, so they follow the reader to another device (preferences under `deepread.prefs` still live in localStorage).

Preferences live in localStorage under `deepread.prefs` and are applied as `data-*` attributes on `<html>`; the stylesheet does the rest.
Pages mode is built on the same window scroll as Scroll mode, so resume, Back and Forward, chapter loading, margin notes and read-aloud work the same in both.
A page turn scrolls so the first line that was not fully shown becomes the next page's first line, and paper strips cover the top margin and any cut line at the bottom.

## How to work on it

1. Install: `pnpm install`.
2. Run: `pnpm dev`, or run the API and Vite separately with your own ports and data folder:
   `DEEPREAD_STORAGE=local ADMIN_PASSKEY= DEEPREAD_API_PORT=8793 DEEPREAD_DATA_DIR=<scratch folder> node server/index.ts` and `DEEPREAD_API_PORT=8793 pnpm exec vite --port 5183 --strictPort`.
   The separate instance starts with `DEEPREAD_STORAGE=local` because a `.env.local` that points at R2 would otherwise make it use the real bucket, and with an empty `ADMIN_PASSKEY=` so a passkey in `.env` does not turn profiles on.
   Add the test book with `curl -s -X POST http://127.0.0.1:8793/api/books -F 'file=@e2e/fixtures/problems-of-philosophy.pdf;type=application/pdf'`.
3. Unit tests and types: `npx vitest run` and `pnpm typecheck`; both must be green before every commit.
   The store contract in `server/storage.test.ts` also runs against the real R2 bucket when you ask for it with `DEEPREAD_TEST_R2=1 pnpm exec vitest run server/storage.test.ts`.
   That run needs the R2 settings in `.env.local`, and it works in a throwaway folder of the bucket that it removes afterwards.
4. Reader-journey tests: follow `e2e/README.md`.
   Give each area (reading, understanding, library, listening) its own instance, ports and data folder.
   The library journeys delete every book in their instance and run one at a time.
   Lint the journey files with the lint command in `e2e/README.md` after editing them.
5. Never commit anything under `data/`; it holds the reader's own books.
   Never commit `.env.local` either; it holds the R2 secret key.

Conventions: Conventional Commits with a body that says why, no co-author lines, no em dashes anywhere, tests first for logic, at most one test file per production module.

Journey tests find the UI by these selectors and labels; keep them or update the journeys in the same change: `.topbar-percent`, `.topbar-title`, `.chapter-head h2`, `.reading-footer`, `#reading-settings-lang`, the theme radios `input[value="light"|"sepia"|"dark"]`, the `Smaller text` and `Larger text` buttons, `.shelf-item`, `a.shelf-link`, `form.shelf-edit`, `.shelf-confirm`, `.drop`, `.drop-busy`, `.inline-error`, `.library-empty`.

## Shipped in this roadmap pass

### 1. Real book covers (implemented on `fix/covers`)

Page 1 is rendered in a worker with a hard timeout. When it is a cover, a roughly 600px-wide WebP is stored beside the PDF and served by `GET /api/books/:id/cover` with an ETag. Books without a cover keep the generated cloth board. Older books are checked one at a time after startup. The cloth board remains visible while an image loads or if it fails. Long titles and the Continue card tooltip have also been corrected.

First-page decisions checked against actual PDFs, after visually inspecting the Gutenberg, scanned and commercial pages:

| PDF | Expected and observed |
| --- | --- |
| `e2e/fixtures/problems-of-philosophy.pdf` | No cover: Gutenberg license, title and contents |
| `data/e2e-library/book-two.pdf`, `book-three.pdf`, `big.pdf` | No cover: each starts with the same Gutenberg page |
| `data/e2e-library/scanned.pdf` | No cover: one line of text on white paper |
| `data/e2e-library/broken.pdf`, `truncated.pdf` | No cover: unreadable PDF |
| Local commercial PDF | Cover: a picture printed inside white margins |

The `data/e2e-library` and commercial files are local verification inputs, not committed fixtures. The tracked Gutenberg file is also asserted in `server/cover.test.ts`. The library screenshot uses a locally drawn cover on a public-domain book, not the commercial PDF.

### 2. Review findings fixed

The review findings in the original handover were implemented with focused coverage:

1. Read-aloud no longer pulls a reader who manually turned ahead back to the voice.
2. The Scroll-mode footer now reports the end of the book when the closing panel is visible.
3. Library file drops explain busy and multi-file states instead of silently swallowing input.
4. Pages mode measures only chapters near the current page, preserving the speedup without cutting the first page.
5. Word cards stay inside the viewport at the reviewed desktop widths.
6. Pages mode keeps streamed chapter summaries inside coherent chapter page bounds.
7. Pages mode now has visible, accessible Previous page and Next page arrow buttons.

### 3. Pages mode journey coverage

Pages mode now has dedicated reading, understanding, listening and summary-navigation journeys.
The new coverage includes keyboard page turns, margin/page interactions, phone swipe behavior, top-bar and footer behavior, streamed recap growth, and the visible Previous page and Next page controls.

### 4. Visual polish pass

The visual pass covered light, sepia and dark themes across desktop, tablet and phone-sized viewports.
The library covers, Continue card, More actions menu, long edit titles, reader starts, Pages boundaries, word cards and phone controls were checked and corrected where needed.

### 5. Books and notes in Cloudflare R2 (commit `542e3f7`)

Books and notes can be kept in a Cloudflare R2 bucket instead of the local data folder, with a limit on how much space the books may take.
Settings come from `.env.local`, then `.env`, in the DeepRead folder (`loadEnvFiles` in `server/env.ts`); a file never overrides a variable that is already set in the shell.
`.env.example` is the committed template, and `.env.local` is gitignored because it holds the secret key.
`server/storage-config.ts` parses these variables, and a setting that cannot work stops the server at start-up with a sentence that names it:

| Variable | Meaning |
| --- | --- |
| `DEEPREAD_STORAGE` | `local` (the default) or `r2` |
| `DEEPREAD_STORAGE_LIMIT` | For example `8GB`; decimal units, and `GiB` and the like for binary; empty means no limit |
| `DEEPREAD_R2_ENDPOINT`, `DEEPREAD_R2_BUCKET`, `DEEPREAD_R2_ACCESS_KEY_ID`, `DEEPREAD_R2_SECRET_ACCESS_KEY` | The bucket and its key; all four are needed when storage is `r2` |
| `DEEPREAD_R2_PREFIX` | The folder inside the bucket that DeepRead keeps to; `deepread/` by default |

What was built:

- `server/storage.ts` holds the `ObjectStore` interface and `createLocalStore`.
  `server/storage-r2.ts` holds `openR2Store` (`@aws-sdk/client-s3`, every key under the prefix, a `HeadBucket` check at start); it is loaded only when storage is `r2`.
- `server/library.ts` was rebuilt on `ObjectStore`.
  A book is the keys `books/<id>/{source.pdf, book.json, meta.json, notes.json, cover.webp|cover.jpg, cache/<sha256>.json}`.
  Uploads are parsed from `<data>/tmp` on this computer whatever the store.
  Adds run one at a time, and also in the book's own queue.
- `GET /api/storage` returns `{used, limit, where}`.
  An upload past the limit is refused with 507 `storage_full`.
  The library page shows "Your books take X, kept in ..." (`.library-storage`); the limit itself is not shown.
- Notes moved from browser localStorage to the server.
  `shared/notes.ts` holds `applyNoteChange`, which the server and the browser both use.
  The routes are `GET /api/books/:id/notes`, `PUT /api/books/:id/notes/:noteId` with `{note, before}`, and `DELETE /api/books/:id/notes/:noteId`.
  `src/reader/noteSync.ts` does the syncing, and `src/reader/useNotes.ts` is a thin hook over it.
- `pnpm storage:migrate` (`scripts/storage-migrate.ts`, `server/copy-books.ts`) copies local books into R2 and never changes the local copy.
  Books already in the bucket are left as they are, and a book that would pass the limit is not copied.
  Run it with DeepRead stopped.

Design decisions:

- A store knows nothing about books: it holds bytes under keys, and `library.ts` gives the keys meaning.
  That is why one contract test can run against the local store and the real R2 store alike.
- `meta.json` is written last and removed first, so a book exists exactly while its `meta.json` does.
  A crash in between leaves files that no listing shows, and the first use after a start clears book folders that have no `meta.json`.
- Notes travel one change at a time (put or remove), never as a whole list, so one device cannot wipe notes added on another.
  The server applies each change inside the book's queue.
- A change the server has not taken yet waits in a localStorage outbox, `deepread.pendingNotes.<bookId>`, and goes with the next change or the next load.
  A change the server refuses (a 4xx answer) is dropped rather than retried.
  Notes this browser kept before, under `deepread.notes.<bookId>[.<chapterId>]`, are adopted into the outbox and their old keys cleared.
- Every reader-journey test server start command begins with `DEEPREAD_STORAGE=local` (`e2e/README.md` says why), and the notes check in the journeys reads the API.

Tests: `server/storage.test.ts` runs one contract against the local store always, and against real R2 only with `DEEPREAD_TEST_R2=1`.
Besides it there are `server/storage-config.test.ts`, `server/copy-books.test.ts`, `src/reader/noteSync.test.ts`, and the notes, limit and start-up cleanup cases in `server/app.test.ts`.

A review pass found and fixed these:

- Whole-list note saves let one device wipe another's notes; saves are now per change.
- Notes deleted offline came back on reload; changes now wait in an outbox.
- Migration temp files piled up on disk.
- Adding a book wrote outside the book's queue and adopted leftovers of an earlier copy; it now runs in the queue and clears the folder first.
- Removing a book failed even though the book was already gone; the files left over are now cleared at the next start.
- PDF streams were not cancelled when the client left.

### 6. Profiles and the admin dashboard (commit `63af8ce`)

Setting `ADMIN_PASSKEY` (and `ADMIN_NAME`) in `.env` turns profiles on; without it DeepRead stays one library with no sign-in.
Everyone picks a profile on **Who's reading?** and types its code, and the browser stays signed in for 30 days.
Each profile has its own library under `profiles/<id>/` in the store; `profiles.json` lists them; the storage limit is shared.
The admin's profile signs in with `ADMIN_PASSKEY` and opens `/admin`: add, edit and delete profiles, upload photos, **Read as** a profile, and **Sign out everywhere**.
Sharing: a book is shared by its owner with other profiles in `shares.json` at the root of the store, and read through the owner's library (`server/shares.ts`, `routes-shares.ts`, `/api/books/:id/shares/:profileId`, `/api/shares`, `/api/admin/shares`).
A shared book goes by `<owner id>--<book id>` on the reader's shelf; their place, notes and cached answers for it are their own, in `profiles/<reader>/shared/<that id>/`, kept when the share stops and removed when the book or a profile is.
Client: `src/library/ShareDialog.tsx`, `SharingPage.tsx`, `src/admin/AdminShares.tsx`.
AI access: with profiles each reader may use only the AI helpers the admin gave them (`aiAccess`, `aiChoice` and `aiRequests` on a profile in `profiles.json`); the admin's own profile may use all that work.
`server/ai.ts` `for(access)` is the one place a reader's questions are answered, so the picker only shows what it decides, and what is installed is looked at once per 30 s, shared by everyone asking.
A third helper, the API Model (`server/openrouter.ts`, OpenRouter), answers with the admin's key and model from `.env` or `data/openrouter.json` (0600); the admin page (`AdminApiModel.tsx`, `AiAccessDialog.tsx`) sets them and gives helpers to readers, and answers their requests from `AiRequestsInbox.tsx` (kept fresh by `useAiRequests.ts`, which polls every 15 s and on focus, and also feeds the tab title and the profile menu's badge); a reader's requests of it count against a daily limit (in memory).
Server: `server/profiles.ts`, `sessions.ts`, `session-token.ts`, `codes.ts`, `throttle.ts`, `avatar.ts`, `routes-session.ts`, `routes-admin.ts`, `app-env.ts`.
Client: `src/profiles/`, `src/admin/`, and `src/reader/noteSync.ts` (the notes outbox is kept per profile).
Tests: `server/profiles-app.test.ts`, `server/codes.test.ts`, `server/session-token.test.ts`, `server/throttle.test.ts`, `server/avatar.test.ts`, `src/admin/profileText.test.ts`, and the profile cases in `src/reader/noteSync.test.ts`.
A security review found nine issues and all were fixed before the commit: the migration deleting skipped books, notes leaking between profiles on a shared browser, a lockout anyone could use against the admin, any profile switching the AI helper, notes lost on a 401, uploads written back after a profile was removed, storage:migrate leaving profiles behind, image decompression bombs, and no way to end a profile's sessions.
It was checked end to end against the real R2 bucket over the API (admin sign-in, a test profile's create, read, update and delete, isolation, Read as, lockout); the screens themselves have not been looked at in a browser yet.

## Next up

The existing operational follow-ups below remain separate from the product work in
[Reader experience roadmap](#reader-experience-roadmap).
That roadmap records the October 2026 UX review and the desired direction; its unchecked items are not shipped features.

Two small follow-ups from the profiles review, each about ten lines:

1. **Lock IPv6 guessers by network, not by address.**
   Wrong codes are counted per profile and per client, and the client is the full `cf-connecting-ip`.
   An attacker on IPv6 can rotate through the addresses of one /64 network and get five fresh tries on each.
   In `server/routes-session.ts` (`clientOf`), key an IPv6 address by its first four groups (its /64), and keep IPv4 as the whole address.
   Add a case to the lockout test in `server/profiles-app.test.ts`: two addresses in the same /64 share one count.
2. **Stop the "Kept ... in books/" line repeating after a crash mid-move.**
   When profiles are first turned on, the books from before move into the admin's profile: copied first, then removed from `books/`.
   If DeepRead stops between the copy and the removal, the next start sees the book as already there, keeps the identical root copy, and logs the "Kept" line on every start.
   In `server/profiles.ts` (the migration), when a skipped book's root copy is identical to the admin's (same `meta.json` `sha256`, and its `notes.json` and progress add nothing the admin's lacks), remove the root copy as well; otherwise keep it as today.
   Add a test next to "should leave a book from before profiles where it is when the admin's profile already has one with its id".

Before deploying: change `ADMIN_PASSKEY` to a long passphrase, rotate the R2 access key, and remove the **Test Reader** profile from `/admin`.

### 7. Known gaps to keep in mind

- Pages: page counts are estimates; a page can end one line earlier after the window height changes; read-aloud started mid-page first turns to the page where the sentence begins.
- Library: two books can share a cloth colour (it is a hash of the title); the Continue card repeats the only book when the library holds one.
- The journey lint warns that the `word-position` module's name does not match its file name.
- Storage: run one DeepRead server per bucket folder; the start-up cleanup of book folders without a `meta.json` could remove a book that another server is still adding; the list of books and each `meta.json` are also kept in memory, so changes made to the store by anything else show only after a restart.
- Notes: a page that was opened earlier picks up notes from another device when the reader comes back to it, and every 30 s while it is in view; it is not instant push.
- Notes: two tabs of the same browser that are both offline share one outbox key, and can overwrite each other's waiting changes.
- Storage: the space used is computed by listing the bucket folder on each upload, which is fine for a personal library.
- Storage: the R2 secret key lives in `.env.local` on the computer.
- Profiles: `profiles.json` is held in memory, so run one DeepRead process per store; two servers on one bucket would see stale profiles.
- Profiles: the wrong-code lock lives in the running server, so a restart clears it.
- Profiles: codes set before the minimum rose to 6 characters still sign in until the admin changes them.
- Profiles: the picker, the admin dashboard and photo upload have not been checked in a browser yet.

## Reader experience roadmap

Added 2026-10-07. Status: planned, not implemented.

### Product goal

Readers should feel that DeepRead is an amazing thing to have and the perfect place to read.
The practical promise is: **a personal reading home that remembers your place, helps you understand, and keeps your thoughts.**
The experience should make a reader feel "I can settle in here", "I can understand this book", and "My thoughts belong here".

Build on the existing product rather than replacing its identity.
Keep Literata and Atkinson, the quiet paper-and-ink surface, blue margin help, personal shelves, highlights, and listening.
Creativity should come from thoughtful interactions and continuity between reading sessions.
The book remains the primary experience; help appears when wanted and leaves the reader's place intact.

### Evidence and starting point

The review inspected the library, reader, settings, chapter aids, note model and synchronization, AI routes, styles, and this roadmap.
Playwright was used with an isolated temporary local library and `e2e/fixtures/problems-of-philosophy.pdf`.
Observed flows: PDF upload, reader opening, opening and closing settings, mobile chapter navigation, and returning to the library.
Desktop screenshots used 1440 x 1000; mobile screenshots used 390 x 844.

Findings that motivate this scope:

- The reading surface is already calm and legible. Preserve this foundation.
- In the inspected mobile chapter opening, the first paragraph began around 400 pixels down the screen, after chapter spacing, title, and preview. More text should be immediately available without hiding the title.
- The Aa panel combines appearance, chapter notes, voice, language, and AI helper configuration. Separate these by reader intent.
- A one-book library repeats the book in Continue reading and the shelf. Its supporting message emphasizes total time remaining rather than context for resuming.
- Highlights and question notes already have source anchors, and progress includes a text offset. These are foundations for contextual resume and a notebook.
- `server/routes-ai.ts` supports chapter quizzes and `/ask`, but `src/reader/ChapterAid.tsx` exposes preview and recap only. Backend capability is not a finished reader experience.
- `shared/types.ts` currently defines notes as questions or highlights, not reader-authored reflections. Question notes retain requests while generated answers are cached separately.
- `src/reader/noteSync.ts` queues writes, but its public contract does not expose saving, saved, offline, or failed states to the UI.

This review did not validate AI answer quality, audible playback, authenticated profile/admin journeys, physical-device gestures, large-library performance, or offline recovery.
Those remain verification work, not assumed successes. The observations are a baseline, not a full accessibility or regression certification.

### Delivery sequence and tracking

Relative effort describes scope, not a delivery-date commitment. Reassess after implementation planning.
The first release should combine reading comfort with returning to a book; the notebook is the next defining product feature.

| ID | Workstream | Order | Relative effort | Depends on |
| --- | --- | --- | --- | --- |
| UX-01 | Reading comfort and contextual controls | First release | Medium | Existing reader and settings |
| UX-02 | Save confidence and recovery | First release foundation | Medium | Note sync and profile isolation |
| UX-03 | Where I left off | First release | Medium | Stable position handling; UX-01 |
| UX-04 | Library organization and finding passages | Shelf improvements first; book search next | Medium | UX-03 return navigation for search detours |
| UX-05 | My edition: notebook and personal reflections | Second release | Medium to large | UX-02; reliable source navigation |
| UX-06 | Passage-grounded questions | After notebook foundation | Medium to large | UX-05 persistence; validated source references |
| UX-07 | Seamless reading and listening | After first release | Medium | UX-01 controls; position regression coverage |
| UX-08 | Optional reflection and saved vocabulary | Later | Medium | UX-05; existing chapter aid and word lookup |
| UX-09 | Connections between ideas | Exploratory, last | To assess | A useful notebook across multiple books |

- [ ] UX-01: Reading comfort and contextual controls.
- [ ] UX-02: Save confidence and recovery.
- [x] UX-03: Where I left off.
- [x] UX-04: Library organization and finding passages.
- [ ] UX-05: My edition notebook and personal reflections.
- [ ] UX-06: Passage-grounded questions.
- [ ] UX-07: Seamless reading and listening.
- [ ] UX-08: Optional reflection and saved vocabulary.
- [ ] UX-09: Connections between ideas, subject to reader evidence.

### Implementation checkpoint: 2026-10-07

Implemented in the repository and checked in local previews; not yet production-deployed:

| Track | Available now | Remaining before closing the track |
| --- | --- | --- |
| UX-01 | Aa contains appearance only; Reader preferences contains language, chapter-note visibility and helper configuration; Voice settings is reachable from the player; shorter phone chapter openings; Escape preserves playback and returns useful focus | Full contextual-help/selection/physical mobile-keyboard checks and logical-position matrix across typography changes |
| UX-02 | Quiet save status; browser-only recovery messaging; explicit retry and discard-refused actions; profile-scoped immutable pending records; separate short append and network locks; malformed recovery records retained without blocking valid work. A native-Web-Locks two-tab browser journey preserved both pending notes through tab close and reload, then retried each exactly once | Broader authenticated live session-expiry, profile-switch, and browser-support matrix; cross-tab network ordering requires native Web Locks, though immutable records prevent shared-outbox overwrite without them |
| UX-03 | Optional library dialog with bounded real preceding text and a resolved preceding highlight; exact highlight source link; one-action Return or deliberate Keep reading here; direct Continue retained. Progress stays at the saved place throughout a source visit, including reload and tab exit. A shared-profile browser journey passed reader-private context, revoked access, and state restoration after reshare | None for the UX-03 acceptance scope; physical-device and production validation remain separate release checks |
| UX-04 | Compact single-book Continue controls without a duplicate cover; title/author and status filtering; manual Reading, Saved for later, and Finished states persisted per reader, including shared copies; bounded literal in-book search with chapter/excerpt results, exact repeated-match marking, and a progress-safe return path. Empty, one-book, three-book, pinned, shared, and keyboard shelf journeys passed in isolated headless browsers | None for the UX-04 acceptance scope; physical-device and production validation remain separate release checks |

Fresh verification: 525 tests across 56 files, typecheck, and production build passed during the status slice. Headless Playwright CLI previously checked appearance/preferences/player interactions, three themes, 390/768/1440 widths, Scroll/Pages navigation, context open/dismiss/retry/Continue, shelf filtering, and a failed highlight save followed by explicit retry and server acknowledgement. Source visits additionally passed exact Return after resize in Scroll and Pages, no progress writes during a visit, reload/exit preservation, Keep reading here adoption, and recovery from a mocked failed cross-chapter return. In-book search passed repeated-result selection and exact text marking, cross-chapter Return with unchanged server progress in Scroll and Pages, no-results, a mocked failed chapter fetch, retry, and Escape dismissal. The status slice passed a two-book browser journey for manual status changes, filter transitions, reload persistence, rollback after a mocked failed write, unchanged progress, and More actions. A separate shared-profile browser journey passed recipient persistence through reload and unshare/reshare while preserving the owner's status; its follow-up also checked recipient actions and pin/unpin. The shelf matrix passed empty upload, one-book Continue/actions, two-book filters, three-book actions, pin/unpin, and reload. A separate keyboard browser journey passed Tab, Enter, Escape, status changes, and focus recovery. Independent checks also covered short 390x600 panels. Retry/error tests deliberately mock failed requests. These are not production deployment or physical-device claims. Repeatable scripts and fixture requirements are in `e2e/README.md`; the updated Momentic journeys were not executed in this pass.

Follow-up isolated browsers also passed a shared-profile UX-03 context/privacy and access-revocation journey and a native-Web-Locks UX-02 two-tab pending-note recovery journey. The latter did not exercise profile switching or session expiry. The save-recovery browser regression first failed because a fixed recovery panel inside the transformed Pages toolbar moved off-screen. Recovery now renders outside that toolbar, while successful save feedback remains quiet inside it. The design detector ran on rendered reader HTML; its advisory book-prose punctuation finding does not justify editing the source text. Existing text/control tokens used by the new UI exceeded 4.5:1 on paper and raised surfaces in all three themes.

An additional headless regression preserved the existing More actions/Edit/Cancel behavior (metadata unchanged and focus restored), chapter navigation back through the shelf and Continue, and theme/font/text-size persistence after reload. Automatic chapter-line generation was blocked for that final navigation rerun; live AI-provider behavior was not re-certified.

Next developer: close the remaining UX-01 and UX-02 acceptance gaps above before starting UX-05. Keep the unchecked workstream boxes until the entire track, not just this slice, meets its acceptance list. Do not add a notebook schema or generated resume recap as part of that verification work.

Independent browser review also reproduced an existing Pages-mode mouse edge case in `usePages.ts`: entering the top margin reveals the toolbar on pointer move, then clicking that same margin can immediately toggle it away. Moving the pointer to the top again recovers it. Investigate with a reproducing pointer sequence before changing the shared page-turn handlers; this pass does not alter them.

### Developer handoff: implementation sequence

**Start with UX-01, then UX-02 and UX-03. Do not implement this entire roadmap in one change.**
The immediate deliverable is a more comfortable reader with reorganized controls, preserving current behavior and saved preferences.
Ship that bounded improvement before adding notebook schemas, new AI interactions, quizzes, vocabulary, or connections.
The first-release sequence began with UX-01 through UX-03 and the small shelf improvements in UX-04. The current local checkpoint also includes book search and explicit reading statuses; finish the remaining acceptance checks before closing UX-04.

#### Step 1: establish the current baseline

1. Read this section, applicable repository instructions, `package.json`, `e2e/README.md`, and the current git diff. Work on the active branch; obtain explicit authorization before git writes.
2. Read `src/reader/ReaderPage.tsx`, `ReadingSettings.tsx`, `ChapterSection.tsx`, `ListenBar.tsx`, `src/prefs.ts`, and the relevant settings/chapter rules in `src/styles.css`.
3. Read `src/reader/useReadingPosition.ts`, `usePages.ts`, and the existing reading journeys before touching layout. Page boundaries, lazy chapter loading, and saved positions depend on the rendered geometry.
4. Start an isolated local instance following `e2e/README.md`, with unused ports and a scratch data directory. Explicitly prevent configured R2 storage or profiles from redirecting the test to real user data. Inspect inherited configuration without printing secrets.
5. Upload the public-domain fixture through the UI. Capture current desktop and phone states for the shelf, chapter opening, Aa panel, contextual help, and player. Include Scroll and Pages and all themes in the verification matrix.
6. Run `pnpm typecheck` and `pnpm test` and record the baseline. Do not treat the historical passing-test statement at the top of this document as current evidence.

Before modifying a shared non-trivial function, inspect its callers and impact using the configured structural tooling.
Do not broadly refactor the reader or split the whole stylesheet as preparation for this work.

#### Step 2: implement UX-01 in reviewable slices

**Slice A: chapter opening and mobile layout.**
Adjust the relevant chapter heading, spacing, and preview presentation rules using the existing tokens and breakpoints.
Keep the chapter title, preview action, reading footer, and page-turn controls available.
Avoid hardcoding a height that only fits the fixture; verify long titles and larger text settings.
Use before/after browser screenshots to establish the visual improvement, plus a journey assertion that the opening text and controls are usable.

**Slice B: appearance versus reader preferences.**
Keep Aa focused on appearance. Move language, AI helper configuration, and chapter-note preference to a discoverable reader-preferences surface.
Move voice setup beside the listening controls, with a discoverable setup path even when playback is stopped or unavailable.
Choose the smallest component split that expresses these responsibilities; do not introduce a new global settings framework.
Preserve the existing preference storage key and values, helper access checks, request states, labels, and native focus/dismissal behavior.
When an existing journey selector changes, update its journey in the same slice.

**Slice C: contextual help and focus.**
Exercise the existing word card, passage toolbar, margin explanation, and player together before changing their placement.
Fix only demonstrated collisions or inconsistent dismissal in this slice.
Keep passage anchoring, touch-selection clearance, Escape handling, and return focus intact.
Do not introduce a second chat interface as part of help-panel cleanup.

For behavior changes, extend existing behavioral tests or journeys and demonstrate the missing behavior before implementing it.
For purely visual CSS changes, use browser evidence rather than tests that assert exact stylesheet text.
After each slice, run focused checks, inspect the diff, and exercise the primary action in the real browser.

Important existing mechanisms to preserve:

- `ReadingSettings.tsx` routes reflowing changes through the existing `reflow`/`keepingLine` path. Moving controls must not bypass position preservation.
- `useReadingPosition.ts` coordinates DOM measurement, `history.state`, URL chapter changes, debounced saving, page hiding, and unmount. A new UI overlay must not accidentally become reading progress.
- `usePages.ts` depends on measured text geometry. A smaller chapter opening must remain coherent in Pages as well as Scroll.
- The settings panel is currently a native popover. Retain native behavior where it fits instead of recreating dismissal and focus management unnecessarily.

#### Step 3: make persistence trustworthy before expanding notes

Implement UX-02 as its own change after the UX-01 baseline is stable.
Start with existing `noteSync.test.ts` and the note API tests, then define observable sync states and demonstrate failure/retry behavior.
Trace state through `noteSync.ts` and `useNotes.ts` to the UI; avoid optimistic "Saved" text before server acknowledgement.
Reproduce the documented two-tab outbox risk before choosing a fix, and verify expired-session recovery and profile switching.
Keep this change about saving and recovery; do not add personal-note fields yet.

#### Step 4: implement a deterministic Where I left off

Implement UX-03 without introducing new AI generation.
Keep Continue as the direct path; add an optional context action that can be opened and dismissed without committing a new position.
Use the saved chapter/block/offset to obtain preceding text through the existing authorized book/chapter access paths.
Clamp and validate offsets, bound the excerpt, and never include text beyond the saved boundary.
If a saved anchor cannot be resolved, show the known chapter and offer a clear fallback rather than pretending the exact passage was restored.

Capture the return position before any source detour.
Explicitly coordinate temporary navigation with the existing debounced save, `pagehide`, visibility-change, and cleanup saves in `useReadingPosition.ts`.
A suppression of scroll events alone will not cover those save paths.
Test closing the context, leaving during a detour, Back/Forward, and reopening the book so the original position is not overwritten unintentionally.

Do not label a highlight "last" unless its recency is actually known.
For the first version, choose a relevant mark near or before the saved position and label it by its chapter/source; chronological history can be added through a deliberate data change later.
Keep context generation and expensive text processing outside scroll/render hot paths.

#### Step 5: finish the first-release shelf and verify the full journey

Apply the small UX-04 shelf changes: avoid redundant one-book presentation while retaining all book actions, improve the Continue context, and add title/author filtering if included in the implementation scope.
Leave within-book search, explicit status persistence, and notebook work for their own follow-up changes.
Do not remove the existing estimate entirely without considering readers who use it; make it secondary to the next reading action.

Run the complete first-release journey in the browser:

1. Add a book and begin reading on a phone-sized viewport.
2. Change text size and layout, then confirm the logical reading place is preserved.
3. Open and dismiss contextual help, use the player, and return to uninterrupted reading.
4. Save a highlight, verify its persistence state, and recover from a simulated interrupted write.
5. Return to the shelf, open resume context, dismiss it, and continue at the saved passage.
6. Follow a context detour and return; reload and confirm that the intended position remains saved.
7. Repeat affected interactions with keyboard navigation, both layouts, and the other themes. Verify actual touch/audio behavior on supported physical devices before claiming it.

Use the existing journey areas under `e2e/momentic/reading`, `reading-pages`, `understanding`, `understanding-pages`, `listening`, `listening-pages`, and `library` as appropriate.
Follow their documented runner prerequisites. If a runner or physical device is unavailable, report the precise verification gap and use available browser automation for the flows it can actually prove; do not mark an untested acceptance criterion complete.
Finish with fresh `pnpm typecheck`, `pnpm test`, and `pnpm build`, plus the browser evidence required above.

#### Definition of the developer's handover

- Update only the completed roadmap items and their acceptance checkboxes. A partially delivered workstream stays open with the finished slice described.
- Record changed files, user-visible behavior, data/contract changes, tests run, browser/device coverage, and known limitations.
- Update affected README guidance and journeys alongside the implementation; do not publish planned features as available features.
- Preserve existing data and explain any migration or recovery procedure introduced by the change.
- Report implementation, verification, commit/PR, and deployment separately. Do not imply that local completion means deployed.
- End the first delivery with a coherent usable reader improvement. The next developer should be able to see exactly which of UX-01, UX-02, and UX-03 remains before starting UX-05.

### UX-01: Reading comfort and contextual controls

**Reader outcome:** "I can settle in here."

Scope:

- Reduce the mobile chapter opening's vertical overhead while keeping the complete chapter title accessible and the start of the text clear.
- Keep appearance controls in Aa: theme, typography, size, spacing, measure, alignment, and layout.
- Put voice selection and download state with Listen; move language and AI helper configuration into reader preferences with a discoverable entry point.
- Preserve existing preferences when reorganizing controls. Do not reset a reader's chosen theme, language, layout, or voice.
- Make contextual help consistent: use the available desktop margin, and a bounded small-screen presentation that respects selection handles, the keyboard, and the listening bar.
- Preserve predictable Escape, dismissal, and keyboard focus return. Opening help must not lose the selected passage or reading position.
- Consider a small set of reversible comfort presets only after refining defaults; keep the existing detailed controls.

Implementation starting points: `src/reader/ReaderPage.tsx`, `ChapterSection.tsx`, `ReadingSettings.tsx`, `WordPopover.tsx`, `SelectionBar.tsx`, `ListenBar.tsx`, `src/prefs.ts`, and `src/styles.css`.

Acceptance:

- [ ] At the inspected phone size, the fixture chapter exposes more opening text than the baseline, without truncating its title or reducing touch-target accessibility.
- [ ] Settings can be reached, changed, and dismissed on phone and desktop in all three themes.
- [ ] Changing font, size, measure, or layout preserves the logical text position in both Scroll and Pages modes.
- [ ] Help, selection, audio controls, and the mobile keyboard do not obscure the action or passage needed to complete a task.
- [ ] Existing stored preferences still load correctly, and keyboard focus returns to a useful target after dismissal.

### UX-02: Save confidence and recovery

**Reader outcome:** "My thoughts are safe here."

Scope:

- Expose meaningful note synchronization states to the UI: saving, saved, waiting for connection, and actionable failure.
- Keep feedback quiet when successful; make unsaved work and recovery actions visible when needed.
- Preserve drafts during retry and session expiry. A refused write must not disappear without an explanation or a way to retain the reader's text.
- Investigate and address the documented shared-outbox risk for two offline tabs before expanding the system to longer personal reflections.
- Distinguish server persistence from a browser-only pending write. Do not imply that an unsent note is available on another device.

Implementation starting points: `src/reader/noteSync.ts`, `useNotes.ts`, `shared/notes.ts`, and existing note routes/tests.
Define the state contract before adding status presentation; avoid a separate competing save mechanism for each new feature.

Acceptance:

- [ ] A note survives refresh after saving and reconnect after a temporarily failed write.
- [ ] Offline edits, session expiry, permanent rejection, and unavailable browser storage produce truthful states and preserve recoverable work.
- [x] Two tabs cannot silently overwrite each other's pending additions in the covered workflow.
- [ ] Switching profiles never renders or submits another reader's pending data.
- [ ] Retry does not duplicate notes or restore a deliberately removed note.

### UX-03: Where I left off

**Reader outcome:** "I am back inside the book immediately."

Scope:

- Preserve the direct Continue action to the saved text position.
- Offer an optional context view containing a bounded preceding excerpt, chapter identity, and a relevant saved highlight when available.
- Use actual book text and saved marks for the first version. Do not require AI or a network-generated recap to resume.
- Opening or dismissing context must not itself advance reading progress.
- Support a one-action return to the original position after a deliberate context or source detour.
- Handle a first visit, absent highlights, missing anchors, and changed viewport dimensions explicitly.
- If generated recaps are introduced later, request them explicitly and limit their input to text before the saved position. A chapter boundary alone is not a sufficient spoiler boundary.

Implementation starting points: `src/library/ContinueCard.tsx`, `src/reader/useReadingPosition.ts`, `ReaderPage.tsx`, `useChapterFlow.ts`, and the progress/note contracts in `shared/types.ts`.
Decide whether a last-highlight timestamp is required: current stored notes do not provide a general creation-time field, so do not infer recency from source order.

Acceptance:

- [x] A returning reader can resume without passing through a mandatory recap.
- [x] Context contains no passage after the saved reading boundary and does not silently change progress.
- [x] Source navigation and return restore the logical block/offset in both reading layouts, including a resized viewport.
- [x] Books without highlights still provide useful, truthful context.
- [x] Shared-book context remains private to the current reader and respects current access.

### UX-04: Library organization and finding passages

**Reader outcome:** "I know where to find things."

Scope:

- Improve the single-book library without removing access to its edit, share, pin, or remove actions.
- Keep Continue visually primary while making the next chapter/context more useful than emphasizing only hours remaining.
- Add title/author search and clear no-results/reset states on the shelf.
- Add explicit reading, finished, and saved-for-later organization, with manual correction. A scroll percentage is not proof that a reader finished or understood a book.
- Add within-book text search with a bounded excerpt and chapter label for each result.
- Open results at their source, mark the match, and offer return to the position before the search.
- Keep scope bounded to metadata and book text first; do not introduce semantic search or a new indexing service without evidence that it is needed.

Implementation starting points: `src/LibraryPage.tsx`, `src/library/bookText.ts`, `BookRow.tsx`, `ContinueCard.tsx`, book chapter/block data, and existing library/storage contracts.
Explicit reading status and book search require new contracts; pinning alone does not implement them.

Acceptance:

- [x] Empty, one-book, many-book, shared, and pinned libraries retain all necessary actions.
- [x] Title/author filtering is responsive and has an accessible clear action and empty state.
- [x] Repeated search terms navigate to the selected occurrence, not merely the first match in the chapter.
- [x] Search detours can return to the previous reading location without leaving misleading saved progress.
- [x] Status changes persist per reader, including for shared books, and can be undone or corrected.

### UX-05: My edition notebook and personal reflections

**Reader outcome:** "This book is becoming mine."

Scope:

- Add a notebook for each book containing highlights, saved explanations, and reader-written reflections.
- Organize entries by chapter with filtering/search and a direct return to the exact source passage.
- Add an explicit reader-authored note type rather than overloading a question request with unrelated text.
- Support create, edit, remove, undo where appropriate, and visible persistence state for personal writing.
- Distinguish the author's quotation, the reader's own words, and an AI-generated explanation visually and in exported output.
- Persist a selected explanation as a durable snapshot when the reader saves it. Current AI cache entries are not a durable notebook contract.
- Export selected entries with book title, author when known, chapter, quotation, and source information. Start with Markdown; preserve attribution and do not export the whole book by default.
- Keep existing highlights and question notes readable without requiring regeneration. Decide how legacy question notes become saved answer snapshots without silently invoking AI.

Implementation starting points: `shared/types.ts`, `shared/notes.ts`, `src/reader/useNotes.ts`, `noteSync.ts`, `NoteCard.tsx`, `useNoteMarks.ts`, and the existing note storage/API.
New persistence fields and validation must be designed together; verify how older entries, unknown kinds, repeated quotations, and deleted sources behave.

Acceptance:

- [ ] A reader can highlight, write a reflection, reopen the book, find both in the notebook, and jump to the correct passage.
- [ ] Repeated quotations retain distinct anchors; missing anchors show an honest unavailable state rather than opening an unrelated passage.
- [ ] Saved explanations remain readable when the provider is unavailable or its cache changes.
- [ ] Editing and retry preserve reader text, with UX-02 recovery behavior covered end to end.
- [ ] Export contains the selected entries and attribution, correctly escapes content, and excludes other readers' data.
- [ ] Shared-book ownership changes and access revocation have an explicit retention/access policy consistent with existing privacy boundaries.

### UX-06: Passage-grounded questions

**Reader outcome:** "I can ask the question I actually have."

Scope:

- Let a reader ask about a selected passage or the current chapter, with scope visible before submission.
- Keep follow-up discussion attached to that context; use the existing `/ask` backend and history contract where suitable.
- Add supporting passage references that open in the book and allow return to the discussion.
- Validate references against the authorized source and allowed reading boundary. Do not treat plausible model-produced identifiers as valid citations.
- Explain when the answer lacks sufficient support; do not present an unsupported interpretation as a quotation or fact from the book.
- Save conversations or selected answers only through an explicit persistence contract, with reader control over retention/removal.
- Handle unavailable helpers, access requests, limits, interrupted streaming, cancellation, and retry without blocking the book.

Implementation starting points: `server/routes-ai.ts`, `server/prompts.ts`, `shared/types.ts`, `src/reader/useAiStream.ts`, and the existing helper-access UI.
Citation structure, source validation, spoiler boundaries, and persistence are additional work; exposing the endpoint alone does not complete this feature.

Acceptance:

- [ ] A reader can ask, follow up, open supporting text, and return without losing either the conversation or reading position.
- [ ] References point to real authorized passages; invalid references are rejected or shown as unavailable.
- [ ] Default context does not include unread text beyond the chosen boundary; any broader scope is an explicit reader choice.
- [ ] Partial or failed answers are distinguishable from completed answers and can be retried locally.
- [ ] AI failure or lack of access does not disable ordinary reading, highlights, or personal notes.

### UX-07: Seamless reading and listening

**Reader outcome:** "Reading and listening are one experience."

Scope:

- Refine switching between visual reading and audio at the current sentence, building on the existing sentence-aware implementation.
- Keep pause, resume, speed, voice choice, download state, and failure recovery close to the player.
- Offer stopping at the end of the current chapter.
- Respect manual navigation while audio is active; make returning to the spoken passage deliberate and predictable.
- Test interruptions and unavailable voices before adding more voice options.
- State offline capabilities precisely: a downloaded natural voice does not by itself make books or the application available offline.

Implementation starting points: `src/reader/ListenBar.tsx`, `useListen.ts`, `useNaturalVoice.ts`, `natural.ts`, `speech.ts`, `sentenceView.ts`, and `ReaderPage.tsx`.

Acceptance:

- [ ] Switching modes resumes at the intended sentence without unexpected backward jumps or skipped passages.
- [ ] Manual reading ahead is not repeatedly overridden by the voice.
- [ ] Chapter-end stop works with lazy chapter loading and both reading layouts.
- [ ] Missing voice support, download failure, and interrupted playback have clear recovery states.
- [ ] Audible playback and interruptions are checked on real supported devices, not inferred from DOM state alone.

### UX-08: Optional reflection and saved vocabulary

**Reader outcome:** "I carry something away."

Scope:

- Offer a quiet, optional chapter pause: revisit a marked passage, write one thought, or answer a short recall question.
- Keep continuing to the next chapter obvious and immediate. Do not require quizzes or turn reading into homework.
- Reuse chapter closing and quiz infrastructure, but implement answer interaction, feedback, persistence choices, and error states explicitly.
- Add a deliberate "Keep this word" action to word lookup, retaining the original sentence, contextual meaning, language, and source.
- Provide a small vocabulary collection with pronunciation and optional recall. A lookup alone must not enroll a word in a study queue.
- Avoid applying the same summary/quiz expectations to every genre or short section.

Implementation starting points: `src/reader/ChapterClosing.tsx`, `ChapterAid.tsx`, `WordPopover.tsx`, `server/quiz.ts`, `server/routes-ai.ts`, and the notebook persistence introduced in UX-05.

Acceptance:

- [ ] All reflection and recall prompts can be skipped without penalty or extra navigation.
- [ ] A saved reflection appears in the notebook at the correct chapter.
- [ ] Saving a word is explicit, avoids accidental duplicates, and preserves its contextual sense rather than only a dictionary headword.
- [ ] Quiz feedback handles unusable AI output and retry without inventing a score or losing submitted answers.
- [ ] Readers can remove saved vocabulary and choose whether to revisit it.

### UX-09: Connections between ideas

**Reader outcome:** "My reading is becoming a body of thought."

This is exploratory scope after the notebook proves useful, not a prerequisite for earlier releases.
Start with a reader linking two saved passages and writing why they belong together.
Show both quotations and their books; allow opening either source and returning.
Only then consider optional AI suggestions, with visible evidence and explicit acceptance.
Do not build a graph visualization or indexing service merely to display a linked pair.

Acceptance before expanding:

- [ ] Readers can create, revisit, edit, and remove a connection between their own saved entries.
- [ ] Each side has clear provenance and respects access changes or missing sources.
- [ ] Suggested connections remain distinct from reader-authored conclusions.
- [ ] Reader observation demonstrates that connections help recall or understanding before investing in a larger discovery interface.

### Shared design and engineering constraints

- Keep the book as the default surface. Avoid an always-open chat sidebar, social feed, decorative dashboard, compulsory quiz, or streak pressure.
- Preserve the existing visual language; improve typography hierarchy, spacing, transitions, and contextual controls rather than adding visual clutter.
- Do not allow streamed content or panel expansion to displace the current reading line unexpectedly.
- Scope all new state to the active reader. Sharing a book does not share private notes, vocabulary, questions, or reading history.
- Reuse existing storage, note synchronization, helper authorization, and rendering paths where their contracts fit. Extend contracts explicitly where they do not.
- Keep data changes recoverable. Document migration, deletion, revoked-share behavior, and export semantics before promising permanent personal content.
- Preserve source anchors using chapter/block/offset information, not viewport coordinates or quotation text alone.
- Keep expensive parsing/search work out of repeated render and scroll paths; measure realistic books and libraries before choosing more infrastructure.
- Update affected user documentation, API contracts, and reader journeys in the same implementation change. Planned behavior must not be described as shipped.

### Verification and release gates

For each workstream, record its implementation change, fresh checks, browser evidence, unresolved limits, and completion date next to its tracking item.
Do not mark a workstream complete because its backend exists or unit tests pass.

Required checks for affected behavior:

- Run type checks and the full automated suite; add focused behavioral coverage for changed contracts, especially position recovery, note persistence, isolation, and source validation.
- Exercise the actual UI with snapshot, primary action, and a new snapshot confirming the resulting state.
- Check desktop, tablet, and phone sizes, Scroll and Pages, and light/sepia/dark themes where relevant.
- Verify keyboard navigation, visible focus, screen-reader labels, text zoom, long titles, and actual contrast against every affected surface.
- Test real iOS/Android selection and audio behavior for touched mobile interactions; desktop emulation alone does not prove those work.
- Cover no-AI, interrupted stream, offline/reconnect, expired session, and revoked share when the feature crosses those states.
- Use isolated libraries for destructive or failure-path testing. Do not run journeys against the reader's real library.
- Run the available design detector on bounded changed UI or rendered output; treat its suggestions as advisory, not a substitute for browser verification.

Reader validation should observe a complete session: import, begin reading, request help, save a thought, leave, resume, and retrieve the thought.
Record lost-place incidents, successful note retrieval, steps/time needed to resume, and whether readers feel interrupted or comfortable returning.
Establish a baseline before setting numeric improvement targets; do not invent engagement scores or equate time spent with reading quality.
Collect only necessary, consented research data and keep book text and private reflections out of analytics by default.

The standard for release is that readers can comfortably complete the journey and trust their place and thoughts to remain available.
Visual polish supports that outcome; it does not establish it on its own.
