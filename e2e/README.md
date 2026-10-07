# Reader-journey tests (Momentic)

These tests drive DeepRead in a real browser the way a reader uses it.
Each journey area has its own Momentic config, so one area's broken file cannot block another area's runs.

| Folder | Covers |
| --- | --- |
| `momentic/library` | Adding, editing and removing books, wrong files, the empty library |
| `momentic/reading` | Whole-book scrolling, the chapter list, resuming, the Aa page settings (theme, font, text size, spacing, margins, alignment), the time-left footer, phone layout |
| `momentic/understanding` | Word lookups, Explain / Example / translation notes |
| `momentic/listening` | Read-aloud, keyboard use, screen-reader structure, contrast |
| `momentic/reading-pages`, `momentic/understanding-pages`, `momentic/listening-pages` | Pages-mode copies of reading, understanding and listening journeys, with independent browser origins and test data |

Tests named `bug-*` describe a known problem and fail until it is fixed.

## Running

Use a separate instance so the tests never touch your own library:

```bash
DEEPREAD_STORAGE=local ADMIN_PASSKEY= DEEPREAD_API_PORT=8792 DEEPREAD_DATA_DIR=data/e2e-reading node server/index.ts
DEEPREAD_API_PORT=8792 pnpm exec vite --port 5182 --strictPort
curl -s -X POST http://127.0.0.1:8792/api/books -F 'file=@e2e/fixtures/problems-of-philosophy.pdf;type=application/pdf'
```

Every server start command here begins with `DEEPREAD_STORAGE=local`.
A `.env.local` that points at R2 would otherwise make the test instance use the real bucket, and the library journeys delete every book in their instance.
The empty `ADMIN_PASSKEY=` keeps profiles off, so the journeys open straight to the library instead of the profile picker.

Then, with `MOMENTIC_API_KEY` set (and `MOMENTIC_SERVER` if your account is not on production):

```bash
pnpm exec momentic run -c e2e/momentic/reading/momentic.config.yaml --url-override http://localhost:5182 -y
```

Give each area its own instance (its own API port, Vite port and data directory, for example `data/e2e-library` for the library journeys).
The library journeys delete every book in the instance they run against, so they must never share one with another area.
They also run one at a time (`parallel: 1` in their config), for the same reason.

Pages-mode journeys set `deepread.prefs` to `{"layout":"pages"}` in localStorage before the first app load.
They have dedicated configs and use separate API/Vite instances and data folders (reading-pages: 8796/5186, understanding-pages: 8797/5187, listening-pages: 8798/5188).
Start each server with `DEEPREAD_STORAGE=local ADMIN_PASSKEY= DEEPREAD_API_PORT=<api> DEEPREAD_DATA_DIR=data/e2e-<area>-pages node server/index.ts` and Vite with `DEEPREAD_API_PORT=<api> pnpm exec vite --port <vite> --strictPort`, then upload the fixture book to each instance before running that area's config.
For each run, use its `momentic.config.yaml` with the matching `--url-override`.
Keep these Pages instances separate from the Scroll areas because saved progress and notes are instance data.

The test book `fixtures/problems-of-philosophy.pdf` is Bertrand Russell's *The Problems of Philosophy*, from Project Gutenberg, in the public domain.

## Headless Playwright checks

For the supported reader journeys, use the isolated runner instead of starting servers and uploading the fixture by hand:

```bash
pnpm e2e:run
pnpm e2e:run notebook
pnpm e2e:run ux02-profile-recovery
```

The first command lists supported names. Each named run chooses unused local ports, forces local storage even when `.env.local` points at R2, creates a temporary data folder, uploads the Gutenberg fixture when needed, uses a unique headless `playwright-cli` session, and closes the browser and servers afterward. Profile journeys use their test-only codes and upload their own fixture through the UI. A failing journey reports the browser output and exits nonzero. `playwright-cli` and the installed project dependencies are required. Keep the manual commands below for journeys that need custom multi-book fixtures or a persistent debugging session.

The scripts below run against the same isolated fixture instance, without a Momentic account or AI calls.
Use `playwright-cli` in separate named sessions; `open` is headless unless `--headed` is added.
Save a reading position partway through a chapter first, so **Where I left off** has preceding text to show.
Keep other reader sessions idle during the library check, which compares the fixture's progress before and after opening and dismissing context.

```bash
playwright-cli -s=deepread-resume-check open http://127.0.0.1:5182
playwright-cli -s=deepread-resume-check run-code --filename e2e/library-resume.js
```

`library-resume.js` checks context text, Close/Escape focus return, no progress writes or AI requests while opening and dismissing, a mocked connection error and retry, dialog bounds at 390/768/1440 pixels, and Continue navigation.
Its title/author filter and clear checks add a second book only to a mocked shelf metadata response; they do not add a book to the server.
Screenshots are written under the ignored `.playwright-cli/` directory.

On a reader route, run the settings and recovery checks in their own sessions:

```bash
playwright-cli -s=deepread-comfort-check open http://127.0.0.1:5182
playwright-cli -s=deepread-comfort-check run-code 'async (page) => { await page.getByRole("link", { name: /^Continue reading / }).click(); }'
playwright-cli -s=deepread-comfort-check run-code --filename e2e/reader-comfort.js
playwright-cli -s=deepread-recovery-check open http://127.0.0.1:5182
playwright-cli -s=deepread-recovery-check run-code 'async (page) => { await page.getByRole("link", { name: /^Continue reading / }).click(); }'
playwright-cli -s=deepread-recovery-check run-code --filename e2e/note-recovery.js
```

`reader-comfort.js` checks split settings, language persistence, focus, player dismissal, three widths and themes, and Scroll/Pages navigation.
`note-recovery.js` aborts a highlight save, checks that recovery stays visible when the Pages toolbar hides, retries and verifies the server's acknowledgement, then deletes only its test-created highlight.
Run recovery only against the isolated fixture library: it writes and removes a note, and reader checks can update saved progress and browser preferences.

For source visits and exact return, use a separate headless session on an isolated fixture instance. The script creates and removes its own highlight, and resets the fixture reading place during the run:

```bash
playwright-cli -s=deepread-detour-check open http://127.0.0.1:5184
playwright-cli -s=deepread-detour-check run-code --filename e2e/reading-detour.js
```

`reading-detour.js` checks source navigation, unchanged server progress during a visit, Return after viewport resizing in Scroll and Pages, and preservation after reload or leaving the visit. Point it at a Vite instance backed by a local test API and the uploaded Gutenberg fixture; replace the example port with that instance's actual port.
To exercise a failed cross-chapter return and its Back to passage recovery on the same isolated instance, run `playwright-cli -s=deepread-detour-error-check open http://127.0.0.1:5184` followed by `playwright-cli -s=deepread-detour-error-check run-code --filename e2e/reading-detour-error.js`. That script routes the return chapter to a temporary 503 and then removes the route. Both detour scripts write fixture progress, so run them only with scratch test data.

`in-book-search.js` searches a repeated term from a saved chapter, selects its second exact occurrence in another chapter, verifies the text mark, and returns without changing server progress in Scroll and Pages. It also checks no-results, Escape dismissal, a mocked chapter-fetch failure, and retry. Run it only on the isolated Gutenberg fixture instance; it resets that fixture's saved place:

```bash
playwright-cli -s=deepread-search-check open http://127.0.0.1:5184
playwright-cli -s=deepread-search-check run-code --filename e2e/in-book-search.js
```

`reading-status.js` needs an isolated two-book shelf: upload `e2e/fixtures/problems-of-philosophy.pdf` and a different PDF such as two copies combined with `pdfunite`. It resets those fixture books to Reading, then verifies Saved for later, Finished, filtering, reload persistence, manual correction, rollback after a mocked failed status write, and unchanged progress:

```bash
playwright-cli -s=deepread-status-check open http://127.0.0.1:5184
playwright-cli -s=deepread-status-check run-code --filename e2e/reading-status.js
```

`reading-status-shared.js` needs a fresh profile-enabled local instance with `ADMIN_NAME=Owner`, `ADMIN_PASSKEY=shared-status-test-code-2026`, and the Gutenberg PDF fixture present. It creates a reader profile, shares a book, and checks that the recipient's Finished status survives reload and unshare/reshare while the owner remains Reading. It also checks the recipient's available actions and pin/unpin behavior:

```bash
playwright-cli -s=deepread-status-shared-check open http://127.0.0.1:5184
playwright-cli -s=deepread-status-shared-check run-code --filename e2e/reading-status-shared.js
```

`reading-detour-shared.js` needs a fresh profile-enabled local instance with `ADMIN_NAME=Owner` and `ADMIN_PASSKEY=shared-detour-test-code-2026`. It checks that each reader's Continue context and highlight remain private, unsharing revokes access, and resharing restores the recipient's state:

```bash
playwright-cli -s=deepread-detour-shared-check open http://127.0.0.1:5184
playwright-cli -s=deepread-detour-shared-check run-code --filename e2e/reading-detour-shared.js
```

`note-cross-tab.js` needs an isolated single-book shelf and a browser with native Web Locks. It opens two tabs, aborts both note writes, verifies distinct pending operations after one tab closes and the other reloads, then retries and confirms each note reaches the server exactly once:

```bash
playwright-cli -s=deepread-cross-tab-check open http://127.0.0.1:5184
playwright-cli -s=deepread-cross-tab-check run-code --filename e2e/note-cross-tab.js
```

`ux01-controls-matrix.js` checks phone and desktop settings, help, selection, listening, three themes, and focus. `ux01-position-matrix.js` checks logical position through font, size, measure, layout, resize, and reload. Both need the isolated Gutenberg fixture; they change its reading place and browser preferences. Browser viewport emulation does not certify a physical phone keyboard or touch handles:

```bash
playwright-cli -s=deepread-ux01-check open http://127.0.0.1:5184
playwright-cli -s=deepread-ux01-check run-code --filename e2e/ux01-controls-matrix.js
playwright-cli -s=deepread-ux01-position-check open http://127.0.0.1:5184
playwright-cli -s=deepread-ux01-position-check run-code --filename e2e/ux01-position-matrix.js
```

`ux02-profile-recovery.js` needs a fresh profile-enabled local instance with `ADMIN_NAME=Owner`, `ADMIN_PASSKEY=ux02-profile-test-code-2026`, and the Gutenberg fixture. It creates a second reader and checks profile isolation, session expiry, retry without duplication, and unavailable browser storage. Use a separate named browser session and scratch data directory.

`notebook.js` needs a fresh, profile-free fixture instance. It creates a reflection at a repeated quotation, reloads, filters, edits through an interrupted save and retry, exports selected entries, opens the exact source, then removes and undoes. `notebook-saved-answer.js` also needs a fresh profile-free fixture instance; it mocks an AI stream, saves the completed answer, then verifies reload and export while all later AI requests fail. Run these on separate scratch instances so each sees one clean book:

```bash
playwright-cli -s=deepread-notebook-check open http://127.0.0.1:5184
playwright-cli -s=deepread-notebook-check run-code --filename e2e/notebook.js
playwright-cli -s=deepread-answer-check open http://127.0.0.1:5184
playwright-cli -s=deepread-answer-check run-code --filename e2e/notebook-saved-answer.js
```

`notebook-shared.js` needs a fresh profile-enabled local instance with `ADMIN_NAME=Owner`, `ADMIN_PASSKEY=shared-notebook-test-code-2026`, and the Gutenberg fixture. It verifies private notebook content and export, revoked access after unshare, and restoration after reshare. Use a separate scratch instance and browser session.
`notebook-missing-source.js` needs a fresh profile-free fixture instance. It changes a test reflection's source offset to a stale value, then confirms **Open passage** reports the missing source without jumping or changing progress.

`library-shelf-matrix.js` needs a fresh empty local shelf and distinct PDFs at `/tmp/deepread-shelf-matrix-second.pdf` and `/tmp/deepread-shelf-matrix-third.pdf`. Make them with `pdfunite` using two and three copies of `e2e/fixtures/problems-of-philosophy.pdf`, respectively. It verifies empty upload, one-book Continue and actions, two-book search and status filtering, pin/unpin focus, reload, and actions on all three rows:

```bash
playwright-cli -s=deepread-shelf-matrix-check open http://127.0.0.1:5184
playwright-cli -s=deepread-shelf-matrix-check run-code --filename e2e/library-shelf-matrix.js
```

`library-keyboard.js` needs an isolated two-book shelf. It resets the two fixture statuses and pins, then checks Tab, Enter, and Escape through filters, search, More actions, pin/unpin, and status changes, including focus when the changed row leaves the active filter:

```bash
playwright-cli -s=deepread-library-keyboard-check open http://127.0.0.1:5184
playwright-cli -s=deepread-library-keyboard-check run-code --filename e2e/library-keyboard.js
```

## Library fixtures

The library journeys upload a few odd files from `data/e2e-library`, which is not in git.
Make them once, from the repo root:

| File | How it is made |
| --- | --- |
| `notes.txt` | Any small text file |
| `broken.pdf` | A text file that starts with `%PDF-1.4` |
| `scanned.pdf` | An image-only PDF: a headless Chrome `--screenshot` of one line of text, then an HTML page holding only that image printed with `--print-to-pdf` |
| `book-two.pdf`, `book-three.pdf` | `pdfunite` of two and of three copies of `fixtures/problems-of-philosophy.pdf` |
| `big.pdf` | `pdfunite` of twelve copies of the same file (this drops the title metadata, which the test needs) |
