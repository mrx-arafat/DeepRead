# Reader-journey tests (Momentic)

These tests drive DeepRead in a real browser the way a reader uses it.
Each journey area has its own Momentic config, so one area's broken file cannot block another area's runs.

| Folder | Covers |
| --- | --- |
| `momentic/library` | Adding, editing and removing books, wrong files, the empty library |
| `momentic/reading` | Whole-book scrolling, the chapter list, resuming, the Aa page settings (theme, font, text size, spacing, margins, alignment), the time-left footer, phone layout |
| `momentic/understanding` | Word lookups, Explain / Example / translation notes |
| `momentic/listening` | Read-aloud, keyboard use, screen-reader structure, contrast |

Tests named `bug-*` describe a known problem and fail until it is fixed.

## Running

Use a separate instance so the tests never touch your own library:

```bash
DEEPREAD_API_PORT=8792 DEEPREAD_DATA_DIR=data/e2e-reading node server/index.ts
DEEPREAD_API_PORT=8792 pnpm exec vite --port 5182 --strictPort
curl -s -X POST http://127.0.0.1:8792/api/books -F 'file=@e2e/fixtures/problems-of-philosophy.pdf;type=application/pdf'
```

Then, with `MOMENTIC_API_KEY` set (and `MOMENTIC_SERVER` if your account is not on production):

```bash
pnpm exec momentic run -c e2e/momentic/reading/momentic.config.yaml --url-override http://localhost:5182 -y
```

Give each area its own instance (its own API port, Vite port and data directory, for example `data/e2e-library` for the library journeys).
The library journeys delete every book in the instance they run against, so they must never share one with another area.
They also run one at a time (`parallel: 1` in their config), for the same reason.

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
