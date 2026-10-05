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

Preferences live in localStorage under `deepread.prefs` and are applied as `data-*` attributes on `<html>`; the stylesheet does the rest.
Pages mode is built on the same window scroll as Scroll mode, so resume, Back and Forward, chapter loading, margin notes and read-aloud work the same in both.
A page turn scrolls so the first line that was not fully shown becomes the next page's first line, and paper strips cover the top margin and any cut line at the bottom.

## How to work on it

1. Install: `pnpm install`.
2. Run: `pnpm dev`, or run the API and Vite separately with your own ports and data folder:
   `DEEPREAD_API_PORT=8793 DEEPREAD_DATA_DIR=<scratch folder> node server/index.ts` and `DEEPREAD_API_PORT=8793 pnpm exec vite --port 5183 --strictPort`.
   Add the test book with `curl -s -X POST http://127.0.0.1:8793/api/books -F 'file=@e2e/fixtures/problems-of-philosophy.pdf;type=application/pdf'`.
3. Unit tests and types: `npx vitest run` and `pnpm typecheck`; both must be green before every commit.
4. Reader-journey tests: follow `e2e/README.md`.
   Give each area (reading, understanding, library, listening) its own instance, ports and data folder.
   The library journeys delete every book in their instance and run one at a time.
   Lint the journey files with the lint command in `e2e/README.md` after editing them.
5. Never commit anything under `data/`; it holds the reader's own books.

Conventions: Conventional Commits with a body that says why, no co-author lines, no em dashes anywhere, tests first for logic, at most one test file per production module.

Journey tests find the UI by these selectors and labels; keep them or update the journeys in the same change: `.topbar-percent`, `.topbar-title`, `.chapter-head h2`, `.reading-footer`, `#reading-settings-lang`, the theme radios `input[value="light"|"sepia"|"dark"]`, the `Smaller text` and `Larger text` buttons, `.shelf-item`, `a.shelf-link`, `form.shelf-edit`, `.shelf-confirm`, `.drop`, `.drop-busy`, `.inline-error`, `.library-empty`.

## What to do next, in order

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

### 2. Remaining review findings

These were verified by reading the code; fix each with a test where the logic allows it.
1. Read-aloud can pull a reader who turned ahead back to the voice: in `src/reader/useListen.ts` (around `scrolledAt`), set the timestamp only when the page actually turned.
2. In Scroll mode the keyboard word cursor can sit under the footer: `src/reader/useWordCursor.ts` uses `innerHeight - 24` as the bottom edge; use the top of `.reading-footer` minus its fade.
3. Dropping files on the library: while an upload runs, a drop is silently swallowed; with several files only the first is added without a word; with the edit dialog open a drop still uploads and navigates away (`src/library/useFileDrop.ts`, `src/LibraryPage.tsx`).
4. Page turns get slower with every chapter loaded: `linesIn` in `src/reader/paging.ts` measures every row of every chapter; limit it to the chapters that overlap the page.
5. The word card runs about 34px past the right edge of a 1280px-wide window when the text is centred; keep it inside the window at every width (`src/reader/WordPopover.tsx` placement and the margin layout in `src/styles.css`).

### 3. Pages mode journey coverage

Pages mode has one journey (`e2e/momentic/reading/pages-mode-desktop.test.yaml`).
Run the reading, understanding and listening journeys with Pages turned on: copy them into their own folder, set `layout: "pages"` in `deepread.prefs` before the first load, and replace scroll steps by page turns (ArrowRight or PageDown).
Add a phone Pages journey (swipe to turn, top bar, footer).

### 4. A visual polish pass

Check every screen in light, sepia and dark at 1440x900, 1280x800 and 390x844: the library, the Continue card, the More actions menu, the edit dialog, the reader at a chapter start, mid-chapter and the end of the book, the Aa menu, Pages mode across a chapter boundary, a word card and the Explain bar.
Look for misaligned edges, uneven spacing, clipped text, anything covering the footer or the top bar, missing focus rings, controls under 44px on the phone and colours that ignore the theme.

### 5. Known gaps to keep in mind

- Pages: page counts are estimates; a page can end one line earlier after the window height changes; read-aloud started mid-page first turns to the page where the sentence begins.
- Library: two books can share a cloth colour (it is a hash of the title); the Continue card repeats the only book when the library holds one.
- The journey lint warns that the `word-position` module's name does not match its file name.
