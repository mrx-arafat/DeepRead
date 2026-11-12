// A few paragraphs of a chapter put into the reader's language by an AI helper that reads the book around them, so the
// result reads like a published edition and not like a service translating one paragraph at a time with no memory.
// What a service cannot know and this can: who is speaking to whom (which decides Bangla's আপনি, তুমি or তুই and the verb
// forms that go with each), what a sentence means at this point in the book, which field a term belongs to, and how a
// name was written a page ago.
// A model's answer is never trusted: it is asked for in a form that names every paragraph by its id, and each paragraph
// is checked before it is kept. A paragraph that fails is asked for once more; one that fails again is handed back to the
// caller, which decides what stands in for it. The answer can therefore never move a translation to another paragraph.
import { LANGUAGES } from "../shared/types.ts";
import type { LangCode } from "../shared/types.ts";
import { completeText, LlmError } from "./llm.ts";
import type { Llm } from "./llm.ts";

/** The book a chapter belongs to, which the helper is told so it can use what it already knows of the book. */
export type AiBook = { title: string; author: string | null };

/** A paragraph of the chapter, with the id the answer names it by. */
export type AiParagraph = { id: string; text: string };

/** A paragraph that came just before the ones asked for, shown for context only: with its translation when there is one. */
export type AiContext = { text: string; translation?: string };

/** How many batches the helper works on at once, over all chapters and readers: the rest of the 3 slots stay for questions. */
export const AI_AT_ONCE = 2;

// The first batch is small so the reader sees the top of the chapter soon; the rest are larger, as every request has a
// fixed cost (the helper starting, the instructions, the context) that bigger batches share. A batch is also never more
// paragraphs than a model can keep apart by their ids.
const FIRST_BATCH_CHARS = 1_500;
const BATCH_CHARS = 4_000;
const MAX_BATCH_BLOCKS = 12;
// The paragraphs before a batch that are shown with it, and the most they may add up to. As many as In Bangla shows for a
// selection (ai-inputs.ts): the book's notes only steer who says আপনি or তুমি to whom when the helper can see who is
// speaking, and measured by tr-style, notes with 6 paragraphs of context did that for 1 line in 10, and with 20 for 10 in 10.
export const CONTEXT_PARAGRAPHS = 20;
export const CONTEXT_CHARS = 8_000;

/** The text of a paragraph that is prose: it has words the helper can translate, and is not a formula, a code listing or a rule. */
export const isProse = (text: string): boolean => (text.match(/\p{Script=Latin}/gu) ?? []).length >= 3;

/** `items` cut into batches in order: a small first one, then larger ones. One paragraph bigger than a batch goes alone. */
export function planBatches<T extends { text: string }>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let chars = 0;
  for (const item of items) {
    const limit = batches.length === 0 ? FIRST_BATCH_CHARS : BATCH_CHARS;
    if (batch.length > 0 && (batch.length === MAX_BATCH_BLOCKS || chars + item.text.length > limit)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += item.text.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// What each language does with "you", for the instructions. Bangla's is spelled out as that is the language readers were
// let down in; the others have the same kind of choice and get a shorter note.
const ADDRESS: Record<LangCode, string> = {
  bn: "Bangla has three levels of address, each with its own pronouns and verb endings: আপনি (আপনি করেন, আপনার), তুমি (তুমি করো, তোমার) and তুই (তুই করিস, তোর); the third person has them too (তিনি করেন, সে করে). A machine translator picks one at random, which makes people in a book sound wrong. You must decide each time.",
  hi: "Hindi has three levels of address: आप, तुम and तू, each with its own verb endings. Decide each time.",
  ur: "Urdu has three levels of address: آپ, تم and تو, each with its own verb endings. Decide each time.",
  ar: "Arabic: keep the register of the speaker and of the relationship, formal or familiar, the same way throughout.",
  es: "Spanish chooses between usted and tú (and vosotros or ustedes). Decide each time.",
  fr: "French chooses between vous and tu. Decide each time.",
  id: "Indonesian chooses between Anda, kamu and the forms of address by title or kinship (Bapak, Ibu, Mas). Decide each time.",
  tr: "Turkish chooses between siz and sen. Decide each time.",
};

// Bangla's two written styles are as far apart as two registers of speech, and a text that mixes them reads as broken.
const STYLE_OF: Partial<Record<LangCode, string>> = {
  bn: "Write in চলিত ভাষা throughout (করছি, তার, তাকে, হয়েছে, এখন) and never mix in সাধু forms (করিতেছি, তাহার, হইয়াছে, এক্ষণে). Use the natural connectives and particles of Bangla (তো, ই, ও, কিন্তু, তবু, বরং, আর) and give dialogue the rhythm of real speech. Narrate in the plain literary চলিত a Bangla novelist would use, not in stiff Sanskritised words unless the English register is high, in one steady narrator voice from paragraph to paragraph. End sentences with । and use the standard modern spelling of a published book.",
};

// How a sentence is built, which is where a translation shows through. Bangla's is spelled out; the others get the general rule.
const ORDER_OF: Partial<Record<LangCode, string>> = {
  bn: "The verb comes last; a modifier or a clause comes before what it modifies, as it does in Bangla and not after it as in English.",
};

export type AiPrompt = { system: string; user: string };

export type ChapterPromptInput = {
  lang: LangCode;
  book: AiBook;
  chapterTitle: string;
  /** Notes about this particular book, written by whoever knows it: its voices, its terms, its names. */
  style?: string;
  /** The paragraphs just before the batch, oldest first. */
  before: readonly AiContext[];
  /** The paragraphs to translate. */
  paragraphs: readonly AiParagraph[];
};

/** How a paragraph is marked in a question and in its answer: on a line of its own, so no text can be mistaken for it. */
const sectionMark = (id: string): string => `=== ${id} ===`;

// The line that ends an answer. Nothing after it is read, so a note a model adds at the end is not taken for part of the last
// paragraph; and an answer without it was cut short, so its last paragraph is not trusted.
const END_ID = "end";

export function chapterTranslationPrompt(input: ChapterPromptInput): AiPrompt {
  const language = LANGUAGES[input.lang];
  const system = [
    `You are a literary translator preparing the ${language} edition of an English book. People will read it for pleasure and to learn from it. A ${language} reader must feel the book was written in ${language}, never that it was translated: the right meaning and the right level of address are only the least that is asked.`,
    "",
    "How you translate:",
    `1. Translate the meaning in context, not the words. Use the paragraphs around the one you are translating to know who is speaking, what has just happened and what the sentence is doing, then write what an author writing in ${language} would write to say that.`,
    `2. Rebuild every sentence the way ${language} builds it. ${ORDER_OF[input.lang] ?? `Follow ${language} word order, not English order.`} Split a long English sentence where a ${language} writer would, and join short ones where one would. Use the active where English uses the passive, say an "it is X that" frame plainly, and leave out a pronoun ${language} does not need.`,
    `3. Never carry an idiom, proverb or figure of speech over word for word. Say it the way a native ${language} writer would, or say the plain meaning. Keep the author's tone, irony and understatement.`,
    `4. Choose the register of address from who is speaking to whom. ${ADDRESS[input.lang]} Decide from their age, rank, closeness and mood, and use the pronouns and the matching verb forms of that level every time they speak to each other, in this batch and in the paragraphs shown before it.`,
    `5. ${STYLE_OF[input.lang] ?? `Write the plain, natural, standard modern ${language} of a published book, in one steady narrator voice.`}`,
    `6. Write names of people and places in ${language} script, spelled as they are in the paragraphs shown before if they appear there, and the same way every time.`,
    `7. Translate a term of a field (philosophy, science, law, and so on) as ${language} books of that field do. Pick the term of the field the book is about, not another field's word that happens to match. When there is no standard term, use the closest ${language} word and put the English term in brackets after it, once.`,
    `8. Be faithful. Say everything the author says and nothing more: no notes, explanations or comments of your own, and no sentence left out. When you rebuild a sentence no word of sense may be lost (a "must", "certainly", "ardently", "seemed", "only", "even", "little", "poor": every adjective, hedge and intensifier is still said, in ${language}'s own way), and none is added for colour. You may split, join and reorder sentences and clauses as rule 2 asks. Keep quotation marks, dashes, lists and line breaks as the author has them, with the punctuation of ${language}.`,
    "9. Numbers, formulas, code, web addresses and symbols stay as written. A heading stays a short heading.",
  ].join("\n");

  const lines = [`Book: "${input.book.title}"${input.book.author ? ` by ${input.book.author}` : ""}.`, `Chapter: "${input.chapterTitle}".`];
  if (input.style?.trim()) lines.push("", "Notes about this book:", input.style.trim());
  if (input.before.length > 0) {
    lines.push("", `The paragraphs just before, for context only. Do not translate them again.${input.before.some((one) => one.translation) ? ` Where a ${language} version is shown, it is the one in the edition: keep names and forms of address consistent with it.` : ""}`);
    for (const one of input.before) {
      lines.push("", `[English] ${one.text}`);
      if (one.translation) lines.push(`[${language}] ${one.translation}`);
    }
  }
  const [example] = input.paragraphs;
  lines.push(
    "",
    `Translate these paragraphs into ${language}. Reply with each one under its own marker line, the id copied exactly as given, every paragraph once and in order, then the closing line ${sectionMark(END_ID)}, and nothing else (no introduction, no notes, no code fences, nothing after the closing line). Like this:`,
    "",
    sectionMark(example?.id ?? "id"),
    `the ${language} text of that paragraph`,
    "",
    sectionMark(END_ID),
    "",
    "The paragraphs:",
  );
  for (const paragraph of input.paragraphs) lines.push("", sectionMark(paragraph.id), paragraph.text);
  return { system, user: lines.join("\n") };
}

/** The user's message asking again for only the paragraphs an answer got wrong, and why. */
function retryHint(bad: ReadonlyMap<string, string>): string {
  const reasons = [...bad].map(([id, reason]) => `- ${id}: ${reason}`);
  return [
    "",
    "",
    "Your last reply could not be used for the paragraphs below. Translate again only these paragraphs, with the same markers, and nothing else:",
    ...reasons,
  ].join("\n");
}

// A marker line: three or more equals signs around the id. Looser than the one asked for, since a model may vary the spacing.
const SECTION = /^[ \t]*={3,}[ \t]*(\S.*?)[ \t]*={3,}[ \t]*$/gm;

/** What a reply holds, by the id of each section. An id sent twice is kept with `null`: neither of them can be trusted. */
export function readSections(reply: string): Map<string, string | null> {
  const found: Array<{ id: string; from: number; to: number }> = [];
  for (const match of reply.matchAll(SECTION)) found.push({ id: match[1] ?? "", from: match.index, to: match.index + match[0].length });
  const sections = new Map<string, string | null>();
  found.forEach((one, at) => {
    // A code fence a model put around its answer is not part of the last paragraph.
    const body = reply.slice(one.to, found[at + 1]?.from ?? reply.length).replace(/^\s*```\w*\s*$/gm, "").trim();
    sections.set(one.id, sections.has(one.id) ? null : body);
  });
  return sections;
}

const NON_LATIN_SCRIPT: ReadonlySet<LangCode> = new Set<LangCode>(["bn", "hi", "ur", "ar"]);
const lettersIn = (text: string): number => (text.match(/\p{L}/gu) ?? []).length;
const latinIn = (text: string): number => (text.match(/\p{Script=Latin}/gu) ?? []).length;
const fold = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// A paragraph that ends a sentence must be translated to the end of it. Checked against 174 such paragraphs the helper
// translated well (15 passages of novels and philosophy, two efforts): none lacked an end mark.
const SENTENCE_END = /[.!?]["'\u201D\u2019)\]]*$/;
const TRANSLATION_END = /[\u0964\u0965.!?\u2026\u061F\u06D4]["'\u201D\u2019\u00BB)\]]*$|["'\u201D\u2019\u00BB)\]]$/;

/**
 * Why `translation` cannot stand for `source`, or null when it can: nothing there, English left in it, text lost, or text
 * added. These are the faults a model's answer has when it is cut short, shifted by a paragraph, or has stopped
 * translating; they say nothing of how good the Bangla is.
 */
export function whyNotTranslation(source: string, translation: string, lang: LangCode): string | null {
  if (translation === "") return "it was empty";
  const words = latinIn(source);
  if (words >= 12 && NON_LATIN_SCRIPT.has(lang)) {
    const letters = lettersIn(translation);
    if (letters === 0) return "it had no words";
    if (latinIn(translation) / letters > 0.4) return `it was still mostly English, not ${LANGUAGES[lang]}`;
  } else if (words >= 20 && fold(translation) === fold(source)) {
    return `it was the English text, not ${LANGUAGES[lang]}`;
  }
  if (source.length >= 60) {
    const ratio = translation.length / source.length;
    if (ratio < 0.3) return "it was far shorter than the English, so part was left out";
    if (ratio > 3.5) return "it was far longer than the English, so something was added";
  }
  if (SENTENCE_END.test(source.trim()) && !TRANSLATION_END.test(translation.trim())) return "it stopped before the end of the last sentence";
  return null;
}

export type BatchInput = ChapterPromptInput & {
  llm: Llm;
};

/**
 * The paragraphs a helper translated well, by id, and the ones it did not with why. When the helper itself failed on the
 * second question, `error` is that failure, `made` still holds what the first answer got right, and the paragraphs the
 * second question was for are in neither map: they were not refused, they were never answered.
 */
export type BatchResult = { made: Map<string, string>; failed: Map<string, string>; error?: LlmError };

/** Splits an answer for the paragraphs asked about into the usable ones and the rest, each with its reason. */
function check(reply: string, asked: readonly AiParagraph[], lang: LangCode): BatchResult {
  const sections = readSections(reply);
  const made = new Map<string, string>();
  const failed = new Map<string, string>();
  const known = new Set(asked.map((paragraph) => paragraph.id));
  const ended = sections.delete(END_ID);
  // A marker nobody asked for means the answer cannot be matched to the question, so none of it is believed.
  const stray = [...sections.keys()].find((id) => !known.has(id));
  const last = asked.at(-1)?.id;
  for (const paragraph of asked) {
    const text = sections.get(paragraph.id);
    if (stray !== undefined) failed.set(paragraph.id, `the reply had a marker "${stray}" that was not asked for`);
    else if (text === undefined) failed.set(paragraph.id, "it was missing from the reply");
    else if (text === null) failed.set(paragraph.id, "it appeared twice in the reply");
    else if (!ended && paragraph.id === last) failed.set(paragraph.id, `the reply did not end with ${sectionMark(END_ID)}, so this last paragraph may be cut short or have a note after it`);
    else {
      const why = whyNotTranslation(paragraph.text, text, lang);
      if (why) failed.set(paragraph.id, why);
      else made.set(paragraph.id, text);
    }
  }
  return { made, failed };
}

/**
 * Asks the helper for `input.paragraphs`, checks each paragraph of its answer, and asks once more for those that failed.
 * Throws LlmError when the helper fails on the first question (not signed in, too slow, over its limit): that is for the
 * caller to answer. A failure of the second question comes back as `error` beside what the first one made.
 */
export async function translateBatch(input: BatchInput): Promise<BatchResult> {
  const prompt = chapterTranslationPrompt(input);
  const ask = (user: string) => completeText(input.llm, { task: "translate", system: prompt.system, user });
  const first = check(await ask(prompt.user), input.paragraphs, input.lang);
  if (first.failed.size === 0) return first;
  const again = input.paragraphs.filter((paragraph) => first.failed.has(paragraph.id));
  const retry = chapterTranslationPrompt({ ...input, paragraphs: again });
  let reply: string;
  try {
    reply = await ask(retry.user + retryHint(first.failed));
  } catch (error) {
    // What the first answer got right is worth keeping whatever became of the second question.
    if (error instanceof LlmError) return { made: first.made, failed: new Map(), error };
    throw error;
  }
  const second = check(reply, again, input.lang);
  return { made: new Map([...first.made, ...second.made]), failed: second.failed };
}
