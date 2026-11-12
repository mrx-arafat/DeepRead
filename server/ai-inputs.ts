// Turns book data into the inputs of a model call, and into the key its answer is cached under.
import { createHash } from "node:crypto";
import type { Block } from "../shared/types.ts";
import type { Prompt } from "./prompts.ts";

/** Chapters longer than this lose their middle, so one request stays within the model's context. */
export const MAX_CHAPTER_CHARS = 400_000;
const KEPT_AT_EACH_END = 200_000;

export function buildChapterText(blocks: Block[]): string {
  const text = blocks.map((block) => (block.type === "heading" ? `## ${block.text}` : block.text)).join("\n\n");
  if (text.length <= MAX_CHAPTER_CHARS) return text;
  return [
    text.slice(0, KEPT_AT_EACH_END),
    "[... The middle of this chapter was left out because it is too long to send. ...]",
    text.slice(-KEPT_AT_EACH_END),
  ].join("\n\n");
}

// How many paragraphs around the tapped one the model sees, per task. The explain prompts lean on earlier
// paragraphs for "what has just happened"; with only one, answers guessed at the situation. A word card only
// needs the sense its sentence gives the word: on six taps across a philosophy book and two novels (matter,
// acquaintance, induction, sensible, spirits, mistress) one paragraph before gave the same sense, the same
// field's Bangla term and as natural an example as six before and two after, with about half the input tokens.
// A line put into the reader's language needs more: who is speaking is often named many paragraphs back ("said he", "Miss
// Bennet, do you know who I am?"), and the respect level of the translation follows from it. On Lady Catherine's line to
// Elizabeth in Pride and Prejudice the book's translator's notes gave the right level in 4 of 5 answers when her name was in
// the context (16 paragraphs back) and in none of 5 when it was not (translation-style.ts). The characters cap keeps a book
// of long paragraphs from sending a wall of text.
const CONTEXT_BLOCKS: Record<"explain" | "word" | "translate", { before: number; after: number; maxBeforeChars?: number }> = {
  explain: { before: 6, after: 2 },
  word: { before: 1, after: 0 },
  translate: { before: 20, after: 2, maxBeforeChars: 8_000 },
};

/** The tapped paragraph with its neighbours, each group labelled so the model knows where the reader is. */
export function buildPassage(blocks: Block[], at: number, task: keyof typeof CONTEXT_BLOCKS): string {
  const current = blocks[at];
  if (!current) throw new Error(`no block at index ${at}`);
  const context = CONTEXT_BLOCKS[task];
  // From the paragraph just before, back as far as the count and the characters allow; the nearest is always kept.
  let from = at;
  let chars = 0;
  while (from > Math.max(0, at - context.before)) {
    const length = blocks[from - 1]!.text.length;
    if (from < at && chars + length > (context.maxBeforeChars ?? Infinity)) break;
    chars += length;
    from -= 1;
  }
  const before = blocks.slice(from, at);
  const after = blocks.slice(at + 1, at + 1 + context.after);
  const parts: string[] = [];
  if (before.length > 0) parts.push(`[Text just before]\n${before.map((block) => block.text).join("\n\n")}`);
  parts.push(`[The reader is on this paragraph]\n${current.text}`);
  if (after.length > 0) parts.push(`[Text just after]\n${after.map((block) => block.text).join("\n\n")}`);
  return parts.join("\n\n");
}

export type CacheKeyParts = {
  task: string;
  mode?: string;
  lang: string;
  chapterId: string;
  blockId?: string;
  selection?: string;
  model: string;
  prompt: Prompt;
};

/**
 * Hash of what makes an answer unique. The prompt text is included on purpose: when prompts.ts is edited
 * or the parser produces different text, old answers stop matching instead of being served stale.
 */
export function cacheKey(parts: CacheKeyParts): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        parts.task,
        parts.mode ?? "",
        parts.lang,
        parts.chapterId,
        parts.blockId ?? "",
        parts.selection ?? "",
        parts.model,
        parts.prompt.system,
        parts.prompt.user,
      ]),
    )
    .digest("hex");
}
