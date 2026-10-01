# DeepRead

Read a book PDF in English and get help right where you get stuck.

- Add a PDF and it is split into chapters and clean, reflowable paragraphs.
- Tap a word to see its meaning in your language, a simple English meaning, and an example.
- Select a sentence or passage and choose **Explain**, **Example**, or **In Bangla** (your language).
  **Explain** covers what it says in simple words, what is going on at that point, the deeper meaning, and the hard words.
  **In Bangla** gives a faithful translation plus a short explanation.
  The answer appears in the margin beside the paragraph.
- Each chapter has a preview before you read and a summary after.
- **Listen** reads the chapter aloud and highlights the sentence and word being spoken.

Everything runs on your own machine.
Books are stored in `data/`.

## Run it

```bash
pnpm install
pnpm dev
```

Then open http://localhost:5173.

## Requirements

- Node 24 or newer and pnpm.
- The [Claude Code](https://claude.com/claude-code) CLI, installed and logged in.
  DeepRead has no API key of its own: explanations and summaries are produced by running `claude` in headless mode with your login.
- Chrome, Edge or Safari (recent versions).

## Limits

- Scanned PDFs (pages that are images) are rejected with a message. OCR is not built yet.
- Figures, tables and images from the PDF are not shown in the reading view.
- Single words are answered by a fast model (about a second). Passages go to a stronger model, which takes a few seconds to start but is accurate and writes natural Bangla.
- An unofficial Google endpoint provides a fallback word translation if the AI answer fails.
- Reading aloud uses the voices built into your browser and operating system.

## Layout

| Path | What lives there |
| --- | --- |
| `shared/types.ts` | The contract between server and web app |
| `server/parser/` | PDF to chapters and paragraphs |
| `server/prompts.ts` | Every prompt sent to the model |
| `server/` | Storage, AI access, quick translation, HTTP routes |
| `src/` | The web app (library and reader) |

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Server on 8787 and web app on 5173, with reload |
| `pnpm build` then `pnpm start` | Production build served by the server on 8787 |
| `pnpm test` | Unit and functional tests |
| `pnpm typecheck` | TypeScript check |
