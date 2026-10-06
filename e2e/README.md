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
DEEPREAD_STORAGE=local DEEPREAD_API_PORT=8792 DEEPREAD_DATA_DIR=data/e2e-reading node server/index.ts
DEEPREAD_API_PORT=8792 pnpm exec vite --port 5182 --strictPort
curl -s -X POST http://127.0.0.1:8792/api/books -F 'file=@e2e/fixtures/problems-of-philosophy.pdf;type=application/pdf'
```

Every server start command here begins with `DEEPREAD_STORAGE=local`.
A `.env.local` that points at R2 would otherwise make the test instance use the real bucket, and the library journeys delete every book in their instance.

Then, with `MOMENTIC_API_KEY` set (and `MOMENTIC_SERVER` if your account is not on production):

```bash
pnpm exec momentic run -c e2e/momentic/reading/momentic.config.yaml --url-override http://localhost:5182 -y
```

Give each area its own instance (its own API port, Vite port and data directory, for example `data/e2e-library` for the library journeys).
The library journeys delete every book in the instance they run against, so they must never share one with another area.
They also run one at a time (`parallel: 1` in their config), for the same reason.

Pages-mode journeys set `deepread.prefs` to `{"layout":"pages"}` in localStorage before the first app load.
They have dedicated configs and use separate API/Vite instances and data folders (reading-pages: 8796/5186, understanding-pages: 8797/5187, listening-pages: 8798/5188).
Start each server with `DEEPREAD_STORAGE=local DEEPREAD_API_PORT=<api> DEEPREAD_DATA_DIR=data/e2e-<area>-pages node server/index.ts` and Vite with `DEEPREAD_API_PORT=<api> pnpm exec vite --port <vite> --strictPort`, then upload the fixture book to each instance before running that area's config.
For each run, use its `momentic.config.yaml` with the matching `--url-override`.
Keep these Pages instances separate from the Scroll areas because saved progress and notes are instance data.

The test book `fixtures/problems-of-philosophy.pdf` is Bertrand Russell's *The Problems of Philosophy*, from Project Gutenberg, in the public domain.

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
