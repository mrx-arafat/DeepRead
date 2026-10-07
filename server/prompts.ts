// Every prompt the app sends to the model lives here, so the teaching voice stays in one place.
import type { ChapterAidKind, ExplainMode } from "../shared/types.ts";

export type Prompt = { system: string; user: string };

export type PassageContext = {
  bookTitle: string;
  chapterTitle: string;
  /** The paragraph the reader is on, plus a little text before and after it. */
  passage: string;
  /** Exactly what the reader tapped or selected inside the passage. */
  selection: string;
  /** English name of the reader's own language, e.g. "Bangla". */
  language: string;
};

export type ChapterContext = {
  bookTitle: string;
  chapterTitle: string;
  chapterText: string;
  language: string;
};

function tutor(language: string): string {
  return [
    `You are a patient reading tutor sitting beside someone who is reading a book in English. Their first language is ${language}.`,
    "They stop you when a word or passage confuses them. Help them understand it and get back to reading quickly.",
    "",
    "How you write:",
    "- Use short sentences and common words. If you must use a hard word, explain it in the same sentence.",
    "- Explain what the author means here, in this book, at this point in it.",
    "- You may use what you know about this book, its author and its ideas to explain deeper meaning. Never invent events that are not in the text.",
    "- Never start with praise or filler such as \"Great question\". Start with the answer.",
    "- Never ask a follow-up question and never offer more help. Stop when the explanation is done.",
    "- Plain text only. You may use **bold** for the one or two terms that matter and lines starting with \"- \" for lists. No headings, no tables, no code blocks.",
  ].join("\n");
}

function passageBlock(ctx: PassageContext): string {
  return [
    `Book: ${ctx.bookTitle}`,
    `Chapter: ${ctx.chapterTitle}`,
    "",
    "The part of the book the reader is on (earlier paragraphs are context):",
    '"""',
    ctx.passage,
    '"""',
  ].join("\n");
}

const EXPLAIN_TASKS: Record<ExplainMode, (ctx: PassageContext) => string> = {
  word: (ctx) =>
    [
      `The reader tapped: "${ctx.selection}"`,
      "",
      "Reply with exactly these three lines and nothing else:",
      `${ctx.language}: the ${ctx.language} word or short phrase for the sense it has in this sentence, written in ${ctx.language} script only (no transliteration). One word or short phrase, not a sentence: a single term, with no brackets and no second term. If the word has several senses, pick the one used here. If it is a term of the book's subject (philosophy, logic, a science, law...), think about which term ${ctx.language} textbooks of that subject use and give that standard term, never a term from another field and never a word-for-word coinage.`,
      "Meaning: what the tapped word or phrase itself means here, in simple English, at most 14 words. Define the word. Do not retell the sentence.",
      "Example: one new, short everyday sentence that uses it in the same sense, worded the way a native English speaker would naturally say it.",
    ].join("\n"),
  simple: (ctx) =>
    [
      `The reader selected: "${ctx.selection}"`,
      "",
      "Explain it the way a good teacher would, so the reader fully understands and can keep reading. Write these parts in this order, each starting with its bold label:",
      "**In simple words:** the same thing said in plain English, 1 to 3 short sentences.",
      "**In context:** what is going on at this point. Use the earlier paragraphs: who is speaking, what has just happened, and why they say this now. 2 to 3 short sentences. If there is a feeling under the words, irony, an idiom or a cultural reference, say it plainly.",
      "**Deeper meaning:** the idea behind it. What does this show about the person, about people in general, or about life? Name the philosophy, psychology or theme it touches and how it connects to what the whole book is about. 2 to 4 short sentences, in simple words. If the selection is plain fact with nothing under it, say so in one sentence instead of forcing a meaning.",
      `**Hard words:** up to 4 lines starting with "- ", each in the form: word - simple English meaning (${ctx.language} meaning in ${ctx.language} script). Only words from the selection that a learner of English would likely not know. Leave this part out if there are none.`,
    ].join("\n"),
  example: (ctx) =>
    [
      `The reader selected: "${ctx.selection}"`,
      "",
      "Make this concrete with one everyday example or comparison from ordinary life (home, school, work, the market, a phone). Write these two parts, each starting with its bold label:",
      "**Picture this:** the example, in 2 to 4 short sentences.",
      "**So here:** 1 or 2 sentences that connect the example back to what the author is saying.",
    ].join("\n"),
  native: (ctx) =>
    [
      `The reader selected: "${ctx.selection}"`,
      "",
      `Reply in ${ctx.language}, written in ${ctx.language} script. Write these two parts, each starting with its bold label (keep the labels in English):`,
      `**Translation:** a faithful, natural ${ctx.language} translation of everything the reader selected, the way a skilled literary translator would write it. Keep the meaning and tone exact. Do not translate word for word, do not shorten, do not add anything.`,
      `**Explanation:** 2 to 4 short sentences in everyday ${ctx.language} on what this means at this point in the book, the way a friend would explain it.`,
      `Write names of people and places in ${ctx.language} script. Use correct, standard ${ctx.language} spelling and grammar.`,
    ].join("\n"),
};

export function explainPrompt(mode: ExplainMode, ctx: PassageContext): Prompt {
  return {
    system: tutor(ctx.language),
    user: `${passageBlock(ctx)}\n\n${EXPLAIN_TASKS[mode](ctx)}`,
  };
}

function chapterBlock(ctx: Pick<ChapterContext, "bookTitle" | "chapterTitle" | "chapterText">): string {
  return [
    `Book: ${ctx.bookTitle}`,
    `Chapter: ${ctx.chapterTitle}`,
    "",
    "Full chapter text:",
    '"""',
    ctx.chapterText,
    '"""',
  ].join("\n");
}

// The closing line is not here: it is written and checked whole, by closingPrompt below.
type StudyAidKind = Exclude<ChapterAidKind, "closing">;

const CHAPTER_TASKS: Record<StudyAidKind, (ctx: ChapterContext) => string> = {
  preview: (ctx) =>
    [
      "The reader is about to start this chapter. Prepare them so it feels easy, without spoiling every detail.",
      "Write, in this order:",
      "1. Two or three short sentences on what this chapter is about and why it matters.",
      "2. A line \"**Watch for:**\" followed by 3 lines starting with \"- \", each one idea to notice while reading.",
      `3. A line "**Hard words:**" followed by up to 6 lines starting with "- ", each in the form: word - simple English meaning (${ctx.language} meaning in ${ctx.language} script). Pick words from the chapter that a learner of English would likely not know.`,
      "Use only what is in the chapter text.",
    ].join("\n"),
  recap: () =>
    [
      "The reader just finished this chapter. Help them keep what matters.",
      "Write, in this order:",
      "1. A line \"**In one sentence:**\" followed by the main point of the chapter in one simple sentence.",
      "2. A line \"**Key ideas:**\" followed by 4 to 6 lines starting with \"- \", each one idea in simple words, in the order the chapter presents them.",
      "3. A line \"**Try this:**\" followed by one small, practical thing the reader could do or notice today because of this chapter.",
      "Use only what is in the chapter text.",
    ].join("\n"),
  quiz: () =>
    [
      "Write 5 multiple-choice questions that check whether the reader understood the main ideas of this chapter.",
      "Ask about ideas and reasons, not tiny details, names or numbers. Use simple words. Each question has exactly 4 options and exactly one correct answer. Wrong options must be believable, not silly.",
      "Reply with only a JSON array, no other text and no code fences. Each item has this exact shape:",
      '{"question": string, "options": [string, string, string, string], "answer": number (0-3, index of the correct option), "why": string (one or two simple sentences on why it is right)}',
      "Vary which position holds the correct answer.",
    ].join("\n"),
};

export function chapterAidPrompt(kind: StudyAidKind, ctx: ChapterContext): Prompt {
  return {
    system: tutor(ctx.language),
    user: `${chapterBlock(ctx)}\n\n${CHAPTER_TASKS[kind](ctx)}`,
  };
}

export type ClosingContext = {
  bookTitle: string;
  chapterTitle: string;
  chapterText: string;
  author: string | null;
  /** The next main chapter, if there is one. Its opening is only there so the model can name the question it takes up. */
  next: { title: string; opening: string } | null;
  /** Where this chapter falls among the main chapters, counting from 0. It picks the frames, so neighbouring chapters do not end alike. */
  shapeIndex: number;
};

const IDEA_FRAMES = [
  "You can now explain why ...",
  "Next time you <everyday situation>, you will notice ...",
  "You can now tell <A> from <B>: ...",
  "You followed the argument from <starting point> to <conclusion>.",
  "You can now answer someone who says <a common view the chapter challenges>: ...",
];

const nextFrames = (author: string | null) => [
  `Next, ${author ? `<surname of ${author}>` : "the book"} asks ...`,
  "The next chapter takes up ...",
  "Still open: ..., which the next chapter takes up.",
];

/** The frame for a chapter's place in the book. The remainder is always in range, so the lookup cannot miss. */
const frameAt = (frames: string[], shapeIndex: number): string => frames[shapeIndex % frames.length]!;

const CLOSING_SYSTEM = [
  "You write the one quiet line a reader sees at the end of a chapter of a book.",
  'Write in English, in simple words, and speak to the reader as "you".',
  "You never praise, cheer, reward or encourage. You only point at one real idea from the chapter and at the question that is still open.",
].join("\n");

export function closingPrompt(ctx: ClosingContext): Prompt {
  const { next } = ctx;
  const where = next
    ? [
        `The next chapter is called: ${next.title}`,
        ...(next.opening ? ["Its opening words:", '"""', next.opening, '"""'] : []),
      ]
    : ["This is the last main chapter of the book."];
  const task = [
    "The reader has just finished this chapter. Write the short closing line they will see at its end.",
    "Sentence 1: name ONE concrete idea, example or distinction from THIS chapter that the reader can now explain or notice. It must be specific to this chapter: if it could be said about any chapter of any book, it is wrong. Use exactly this frame, filling in the dots and the parts in <angle brackets>:",
    frameAt(IDEA_FRAMES, ctx.shapeIndex),
    ...(next
      ? [
          "Sentence 2: name the open question the next chapter takes up, in plain words, without giving away its answer. Take it from the next chapter's title and opening. Use exactly this frame, filling it in the same way:",
          frameAt(nextFrames(ctx.author), ctx.shapeIndex),
        ]
      : ["There is no next chapter, so write only sentence 1."]),
    "",
    "Rules:",
    "- At most 45 words in total.",
    "- No praise or encouragement, no exclamation marks, no emoji, no markdown, and no quotation marks around the whole reply.",
    '- No filler such as "great", "journey", "dive into" or "keep going".',
    "- Use only what the chapter text and the next chapter's title and opening say.",
    "- Reply with only the sentence or sentences.",
  ];
  return { system: CLOSING_SYSTEM, user: [chapterBlock(ctx), "", ...where, "", ...task].join("\n") };
}

// Praise and stock phrases, matched in any case. A stem also matches its endings ("unlocks", "proudly"); dive and delve are
// whole words so that "diverse" passes.
const CLOSING_BANNED =
  /\b(?:well done|great (?:job|work)|good job|nice work|amazing|awesome|fantastic|impressive|incredible|congrat|proud|kudos|keep it up|keep going|way to go|you did it|journey|unlock|superpower|dive[sd]?\b|delve[sd]?\b|delving\b)/i;
const QUOTE_PAIRS = [['"', '"'], ["\u201C", "\u201D"], ["'", "'"], ["\u2018", "\u2019"]] as const;
// The prompt asks for 45. Good replies on a real book ran 46 to 51 words with the longer frames, and a few words more is not worth a second model call.
const MAX_CLOSING_WORDS = 55;

/** The closing line cleaned up (trimmed, on one line, one pair of wrapping quotes gone), or null when it breaks a rule. */
export function checkClosing(reply: string, { hasNext }: { hasNext: boolean }): string | null {
  let text = reply.trim();
  const quotes = QUOTE_PAIRS.find(([open, close]) => text.length > 1 && text.startsWith(open) && text.endsWith(close));
  if (quotes) text = text.slice(1, -1).trim();
  if (text === "" || /^- /m.test(text)) return null;
  text = text.replace(/\s+/g, " ");
  if (/[*#`!]/.test(text) || /\p{Extended_Pictographic}/u.test(text) || CLOSING_BANNED.test(text)) return null;
  if (!/\b(?:you|your)\b/i.test(text) || text.split(" ").length > MAX_CLOSING_WORDS) return null;
  // SHORTCUT: a sentence ends at "." or "?" before a capital letter, so "Dr. Smith" counts as two. The line is then asked for again and refused; add an abbreviation list if that ever shows up.
  const sentences = text.split(/(?<=[.?]["')]*)\s+(?=\p{Lu})/u).length;
  return sentences <= (hasNext ? 2 : 1) ? text : null;
}

export function askPrompt(
  ctx: ChapterContext,
  history: { role: "user" | "assistant"; text: string }[],
  question: string,
): Prompt {
  const earlier = history
    .map((turn) => `${turn.role === "user" ? "Reader" : "Tutor"}: ${turn.text}`)
    .join("\n");
  return {
    system: [
      tutor(ctx.language),
      "",
      "The reader will ask a question about the chapter. Answer from the chapter text. Keep it under 120 words unless they ask for more.",
      "If the chapter does not answer the question, say so in one sentence, then give your best short answer from general knowledge and make clear it is not from the book.",
      `Answer in English unless the reader writes in ${ctx.language} or asks for ${ctx.language}.`,
    ].join("\n"),
    user: [
      chapterBlock(ctx),
      earlier ? `\nConversation so far:\n${earlier}` : "",
      `\nReader's question: ${question}`,
    ].join("\n"),
  };
}
