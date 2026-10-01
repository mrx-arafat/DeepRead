# Reader-journey tests (Momentic)

These tests drive DeepRead in a real browser the way a reader uses it.
Each journey area has its own Momentic config, so one area's broken file cannot block another area's runs.

| Folder | Covers |
| --- | --- |
| `momentic/library` | Adding, editing and removing books, wrong files, the empty library |
| `momentic/reading` | Whole-book scrolling, the chapter list, resuming, text size, theme, phone layout |
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

The test book `fixtures/problems-of-philosophy.pdf` is Bertrand Russell's *The Problems of Philosophy*, from Project Gutenberg, in the public domain.
