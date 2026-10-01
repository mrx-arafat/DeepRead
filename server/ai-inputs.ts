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

// How many paragraphs around the tapped one the model sees. The explain prompts lean on earlier paragraphs
// for "what has just happened"; with only one, answers guessed at the situation.
const BLOCKS_BEFORE = 6;
const BLOCKS_AFTER = 2;

/** The tapped paragraph with its neighbours, each group labelled so the model knows where the reader is. */
export function buildPassage(blocks: Block[], at: number): string {
  const current = blocks[at];
  if (!current) throw new Error(`no block at index ${at}`);
  const before = blocks.slice(Math.max(0, at - BLOCKS_BEFORE), at);
  const after = blocks.slice(at + 1, at + 1 + BLOCKS_AFTER);
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
