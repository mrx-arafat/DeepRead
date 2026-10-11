# PDF content preservation

DeepRead previously emitted only headings and paragraphs. That discarded illustrations, flattened code and lists, combined prose columns, and rejected scanned pages. This implementation extends the existing PDF.js pipeline instead of replacing it with a service that would send private books elsewhere or rewrite their words.

## Research and decisions

- PDF.js exposes page text, graphics operators, transforms and rendering through [PDFPageProxy](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html). The implementation was checked against the installed `pdfjs-dist` 6.3.289 source: its `constructPath` arguments include local bounds, and optimized image operations need their own transforms.
- [Tesseract TSV output](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html#tsv-output) gives word boxes and confidence. Mapping those boxes back to PDF coordinates lets the existing paragraph and chapter heuristics operate on recognized text. Low-confidence words are discarded. Native selectable text stays the preferred source.
- PDF.js font objects identify bold, italic, serif, sans and monospace glyphs. Exact character ranges project these styles onto normalized text, including repaired line-end hyphens. Relative size, alignment and captions retain their hierarchy while reader font and prose-alignment preferences remain effective.
- Styled spans and semantic table cells retain the exact `block.text` content. Shared DOM mapping translates between nested text nodes and logical character offsets for selections, highlights, speech, search, notebook links and saved positions. Printed Markdown remains literal; PDFs do not supply Markdown source semantics.
- Figures are rendered from the source page, preserving masks, vector graphics and colors. Transform-aware crops retain their placement; nearby vector primitives are combined. Backgrounds, thin rules and very small ornaments are excluded. This is a conservative heuristic, not a complete PDF layout engine.

## Data and permissions

`Block` remains backward compatible: old heading/paragraph books require no migration. New code blocks preserve newlines and indentation; list paragraphs retain their printed markers. Image blocks have empty text and separate image metadata. OCR labels absent from the native text layer become ordinary selectable `figure-text` paragraphs after the figure.

Source-relative typography and inline runs preserve emphasis and font families. Strong repeated cell geometry becomes semantic tables with tabs/newlines in the exact selectable text; conservative thresholds protect prose columns and contents pages. Captions remain alongside figures. Reflow uses installed reading fonts in the source family rather than distributing arbitrary embedded font files.

The parser supplies PNGs temporarily. `library.add` deduplicates them by SHA-256, writes them under `books/<id>/figures/<hash>.png`, and stores only relative paths in `book.json`. Their bytes count against the storage limit. ObjectStore storage, scoped profiles, encryption, copying and deletion apply to these assets as they do to the rest of each book.

`GET /api/books/:id/figures/:name` uses the reader's shelf permissions. Shared readers may see figures while a share remains active; they still cannot fetch the owner's source PDF. The route accepts only hash-named PNGs and requires private cache revalidation. The renderer accepts only book-relative asset paths.

Each chapter offers **Original pages**: an accessible modal with page navigation and zoom displays the actual source page, including its embedded fonts, underline rules, tables, equations and complex placement. `GET /api/books/:id/pages/:page` applies those same shelf permissions and private cache revalidation. Two concurrent source-page slots cover storage downloads, rendering and temporary cleanup across profiles. Render workers have hard time and image-size limits. A small memory cache avoids repeated rendering without storing more book assets or bypassing revocation.

## Local OCR and resource limits

Install Tesseract on the server (`sudo apt-get install tesseract-ocr tesseract-ocr-eng` on Ubuntu/Debian, or `brew install tesseract` on macOS). English is the default. Install additional language data and set `DEEPREAD_OCR_LANG=eng+ben`, for example, for English and Bangla. OCR never uses the configured AI helpers or an external service.

PDF parsing retains worker isolation and a hard timeout. Rendering is capped at four million pixels and 2400 pixels per side. Each crop is capped at 2 MiB; the book has a count and byte budget. Up to two ordinary figures per page undergo label OCR; complete scans use page OCR. OCR has a subprocess watchdog and bounded output; its independent timer terminates Tesseract and removes temporary files even if the PDF worker is terminated. Page processing shares a deadline across graphics, rendering and OCR. Missing OCR, bad language data or failed figures yield explicit warnings rather than losing native book text.

An original scan is retained as an image alongside its recognized text. Image-only books with no usable recognized text are still rejected. Books already stored are not reparsed, because changing their block IDs or text could invalidate existing notes and progress.

## Focused verification

Generated PDFs cover prose columns, list continuations, monospace code, figure placement, OCR and blank pages. Reader checks cover private image rendering, page boundaries, voice filtering, multiline code notes, highlights spanning figures, text search, translation, and saved positions. Shared-book route tests cover asset access and revocation. The `pdf-content` browser journey checks real PDF upload, loaded private assets, figure order and desktop/mobile layouts. Run it with `node scripts/e2e-runner.mjs pdf-content`.

Complex magazine layouts, merged table cells, arbitrary embedded fonts, equations and underline rules are preserved in **Original pages**, with conservative reflow approximations. Handwriting and automatic rotated-scan correction remain recognition limitations. OCR output should be checked against the source page when accuracy matters.
