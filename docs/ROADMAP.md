# DeepRead roadmap and handover

This file is for the next developer.
It says what was just built, what is left, in what order, and how to do each part.

## Where things stand

The reader and the library were redesigned to feel like a calm e-reader.
Everything below is on `main`, with unit tests and reader-journey tests passing.

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
- Storage: run one DeepRead server per bucket folder; the start-up cleanup of book folders without a `meta.json` could remove a book that another server is still adding.
- Notes: a page that was opened earlier sees notes from another device only after a reload.
- Notes: two tabs of the same browser that are both offline share one outbox key, and can overwrite each other's waiting changes.
- Storage: the space used is computed by listing the bucket folder on each upload, which is fine for a personal library.
- Storage: the R2 secret key lives in `.env.local` on the computer.
- Profiles: `profiles.json` is held in memory, so run one DeepRead process per store; two servers on one bucket would see stale profiles.
- Profiles: the wrong-code lock lives in the running server, so a restart clears it.
- Profiles: codes set before the minimum rose to 6 characters still sign in until the admin changes them.
- Profiles: the picker, the admin dashboard and photo upload have not been checked in a browser yet.
