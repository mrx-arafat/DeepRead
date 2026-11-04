// Open in ChatGPT: a deep dive handed to an outside chat, built here from what the reader's page already has. No
// server route and no API call: the link carries the prompt, and the prompt is copied too in case the chat opens empty.

export const HANDOFF_TARGET_IDS = ["chatgpt", "claude", "perplexity", "google", "gemini", "copy"] as const;
export type HandoffTarget = (typeof HANDOFF_TARGET_IDS)[number];

/** Each chat: where it opens with a prompt in its box (`open` + the encoded prompt), and its door when the prompt must be pasted. */
export const HANDOFF_TARGETS: Record<HandoffTarget, { name: string; open: string | null; home: string | null }> = {
  chatgpt: { name: "ChatGPT", open: "https://chatgpt.com/?q=", home: "https://chatgpt.com/" },
  claude: { name: "Claude", open: "https://claude.ai/new?q=", home: "https://claude.ai/new" },
  perplexity: { name: "Perplexity", open: "https://www.perplexity.ai/search?q=", home: "https://www.perplexity.ai/" },
  google: { name: "Google AI Mode", open: "https://www.google.com/search?udm=50&q=", home: "https://www.google.com/" },
  // Gemini has no address that takes a prompt: the prompt is copied and the app opened for it to be pasted.
  gemini: { name: "Gemini", open: null, home: "https://gemini.google.com/app" },
  copy: { name: "Copy prompt", open: null, home: null },
};

/** Far under what browsers take (Chromium allows 2 MB) and under Claude's cut at about 14,000 characters. */
export const MAX_HANDOFF_URL_CHARS = 6000;

export type HandoffPassage = {
  bookTitle: string;
  author: string | null;
  chapterTitle: string;
  /** English name of the reader's language, e.g. "Bangla". */
  language: string;
  /** The paragraph before the one the reader is on, when there is one. */
  before: string | null;
  /** The paragraph the selection is in. */
  paragraph: string;
  selection: string;
};

export type HandoffLink = {
  target: HandoffTarget;
  /** The chat's name, as the button says it. */
  label: string;
  prompt: string;
  /** Where the link goes: the chat with the prompt in its box, its door when the prompt did not fit, none for Copy only. */
  href: string | null;
};

/** The paragraph with the selection between >> and <<. A selection not found in it (one that ran over paragraphs) stands alone. */
function marked(paragraph: string, selection: string): string {
  const at = paragraph.indexOf(selection);
  if (at < 0) return `>>${selection}<<`;
  return `${paragraph.slice(0, at)}>>${selection}<<${paragraph.slice(at + selection.length)}`;
}

/** Where each sentence of `text` starts: after a full stop, question or exclamation mark, any closing quote, and a space. */
function sentenceStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/[.!?]["'\u201d\u2019)]*\s+/g)) starts.push(match.index + match[0].length);
  return starts;
}

/** The selection's sentence or sentences with one more each side: what the paragraph is cut to when the link is too long. */
function aroundSelection(paragraph: string, selection: string): string {
  const at = paragraph.indexOf(selection);
  if (at < 0) return paragraph;
  const starts = sentenceStarts(paragraph);
  const first = starts.findLastIndex((start) => start <= at);
  const last = starts.findLastIndex((start) => start < at + selection.length);
  const from = starts[Math.max(0, first - 1)] ?? 0;
  const to = starts[last + 2] ?? paragraph.length;
  return paragraph.slice(from, to).trim();
}

function promptText(passage: HandoffPassage, before: string | null, paragraph: string): string {
  const by = passage.author ? ` by ${passage.author}` : "";
  return [
    `I am reading "${passage.bookTitle}"${by}, chapter "${passage.chapterTitle}", in English. My first language is ${passage.language}.`,
    "",
    "The part of the book I am on (the words I selected are between >> and <<):",
    '"""',
    ...(before ? [before, ""] : []),
    marked(paragraph, passage.selection),
    '"""',
    "",
    "Go deep on the selected part:",
    "1. Say it again in very simple English, as if to a 15-year-old.",
    "2. What is happening at this point in the book, and why the author says this here.",
    "3. The deeper meaning: what it shows about people, the mind, or life. Name the psychology or philosophy behind it in plain words.",
    "4. Two real-life examples from everyday life (home, work, school, a phone) where the same thing happens.",
    `5. The hard words in the selected part, each with a simple meaning and the ${passage.language} word in ${passage.language} script.`,
    "Short sentences. No praise, no questions back. Answer in English.",
  ].join("\n");
}

/**
 * The link for `target`: the prompt, and where it opens. When the link would be too long, the paragraph before goes
 * first, then the paragraph is cut to the sentences around the selection; if even that is too long, the chat opens
 * empty and the reader pastes the copied prompt, which is never cut. The selection itself is never cut either.
 */
export function handoffLink(target: HandoffTarget, passage: HandoffPassage): HandoffLink {
  const { name, open, home } = HANDOFF_TARGETS[target];
  const whole = promptText(passage, passage.before, passage.paragraph);
  if (!open) return { target, label: name, prompt: whole, href: home };
  const shorter = [whole, promptText(passage, null, passage.paragraph), promptText(passage, null, aroundSelection(passage.paragraph, passage.selection))];
  for (const prompt of shorter) {
    const href = `${open}${encodeURIComponent(prompt)}`;
    if (href.length <= MAX_HANDOFF_URL_CHARS) return { target, label: name, prompt, href };
  }
  return { target, label: name, prompt: whole, href: home };
}
