// A translator's style sheet for one book in one language: what a human translator keeps beside the manuscript so that
// "the Company" is always the same word, Marlow is always spelled the same way, and two people always address each other
// with the same respect level (আপনি, তুমি or তুই). A translation service works a paragraph or a line at a time and picks
// these at random; with the sheet's notes in every translation prompt of the book (a chapter, the "In Bangla" answer, a
// tapped word) they agree.
// The AI helper makes the sheet once, from a sample of the book's chapters (the talkative parts first, since respect levels
// show in dialogue), and after that it only ever adds: an entry once fixed is never changed, so what a reader has already
// seen stays true. It is kept with the book (library.ts readStyle and writeStyle, style/<lang>.json).
import { LANGUAGES } from "../shared/types.ts";
import type { Chapter, LangCode, ParsedBook } from "../shared/types.ts";
import { isRecord } from "./http.ts";
import type { Library } from "./library.ts";
import { completeText } from "./llm.ts";
import type { Llm } from "./llm.ts";
import { styleAdditionsPrompt, styleSheetPrompt } from "./prompts.ts";
import type { StyleSheetContext } from "./prompts.ts";

export type RespectLevel = "formal" | "familiar" | "intimate";
const LEVELS: readonly RespectLevel[] = ["formal", "familiar", "intimate"];

export type StyleCharacter = { name: string; rendering: string; role: string };
export type StyleAddress = { from: string; to: string; level: RespectLevel; why: string };
export type StyleTerm = { term: string; rendering: string };

/** What is decided for one book in one language. */
export type BookStyle = {
  lang: LangCode;
  /** One line: who tells the book, in what voice, and the register to keep. */
  narrator: string;
  characters: StyleCharacter[];
  /** How `from` speaks to `to`. `why` is the model's reason; it is kept to review the sheet and not sent to a translation. */
  address: StyleAddress[];
  glossary: StyleTerm[];
  /** Capitalised names the model has been shown, so that only a name it has not seen sends a chapter back to it. */
  seen: string[];
};

/** The pronoun of each respect level in the languages that have such levels. Two-level languages repeat the second. */
const PRONOUNS: Partial<Record<LangCode, Record<RespectLevel, string>>> = {
  bn: { formal: "আপনি", familiar: "তুমি", intimate: "তুই" },
  hi: { formal: "आप", familiar: "तुम", intimate: "तू" },
  ur: { formal: "آپ", familiar: "تم", intimate: "تو" },
  es: { formal: "usted", familiar: "tú", intimate: "tú" },
  fr: { formal: "vous", familiar: "tu", intimate: "tu" },
  tr: { formal: "siz", familiar: "sen", intimate: "sen" },
};

/** The script a language's names are written in when it is not Latin, and what a rendering in it must contain. */
const SCRIPTS: Partial<Record<LangCode, { name: string; letters: RegExp }>> = {
  bn: { name: "Bangla script", letters: /\p{Script=Bengali}/u },
  hi: { name: "Devanagari script", letters: /\p{Script=Devanagari}/u },
  ur: { name: "Urdu script", letters: /\p{Script=Arabic}/u },
  ar: { name: "Arabic script", letters: /\p{Script=Arabic}/u },
};

/** The most the notes sent with a prompt run to, so they never crowd out the text being translated. */
export const MAX_NOTES_CHARS = 1_400;
const MAX_NAME = 60;
const MAX_NARRATOR = 200;
const MAX_ROLE = 80;
const MAX_WHY = 100;
const MAX_ENTRIES = { characters: 30, address: 40, glossary: 40, seen: 300 };

const SAMPLE_CHARS = 30_000;
const MAX_SAMPLED_CHAPTERS = 12;
const MAX_CHAPTER_SAMPLE_CHARS = 8_000;
const GROW_SAMPLE_CHARS = 10_000;
const RECURRING_NAMES = 24;
const NEW_NAMES = 12;
/** A name that appears this often in a chapter and was never shown to the model sends the chapter to it. */
const NEW_NAME_MIN_COUNT = 2;
const RETRY_HINT =
  "\n\nYour last reply could not be read. Reply with only the JSON object described above: no code fences, no other text.";
const FAILURE_COOLDOWN_MS = 10 * 60_000;
/** How long "this book has no notes" is believed, so that a tap does not ask the store again and again, and a read that failed heals. */
const NO_NOTES_HOLDS_MS = 60_000;

// ---- Reading a sheet: from the model's reply and from the book's file ----

/** `value` as one line, with the characters the notes are laid out with taken out. Too long: cut when `cut`, else "" (dropped). */
function clean(value: unknown, max: number, cut = false): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/[;\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  if (!cut) return "";
  // At a word, never inside one: a line that stops in the middle of a word would be sent to every prompt that way.
  const head = line.slice(0, max);
  const space = head.lastIndexOf(" ");
  return (space > max / 2 ? head.slice(0, space) : head).trim();
}

/** `items` without a second entry for the same key, which the first one holds. */
function unique<T>(items: T[], keyOf: (item: T) => string): T[] {
  const keys = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item).toLowerCase();
    return !keys.has(key) && keys.add(key);
  });
}

type Lists = Pick<BookStyle, "characters" | "address" | "glossary">;

/** The three lists of a sheet or of an addition to one. Entries that are not whole are left out; a list that is not a list rejects it. */
function readLists(value: Record<string, unknown>, lang: LangCode): Lists | null {
  const letters = SCRIPTS[lang]?.letters;
  // A name left in Latin letters in a Bangla sheet is the model not translating it.
  const written = (rendering: string): boolean => rendering !== "" && (!letters || letters.test(rendering));
  const listOf = (key: string): unknown[] | null => {
    const list = value[key];
    return list === undefined ? [] : Array.isArray(list) ? list : null;
  };
  const [characters, address, glossary] = [listOf("characters"), listOf("address"), listOf("glossary")];
  if (!characters || !address || !glossary) return null;

  const people = characters.flatMap((entry): StyleCharacter[] => {
    if (!isRecord(entry)) return [];
    const person = { name: clean(entry.name, MAX_NAME), rendering: clean(entry.rendering, MAX_NAME), role: clean(entry.role, MAX_ROLE, true) };
    return person.name !== "" && written(person.rendering) ? [person] : [];
  });
  const pairs = address.flatMap((entry): StyleAddress[] => {
    // A language without respect levels has no pairs to keep.
    const level = isRecord(entry) && PRONOUNS[lang] ? LEVELS.find((one) => one === entry.level) : undefined;
    if (!isRecord(entry) || !level) return [];
    const pair = { from: clean(entry.from, MAX_NAME), to: clean(entry.to, MAX_NAME), level, why: clean(entry.why, MAX_WHY, true) };
    return pair.from !== "" && pair.to !== "" && pair.from.toLowerCase() !== pair.to.toLowerCase() ? [pair] : [];
  });
  const terms = glossary.flatMap((entry): StyleTerm[] => {
    if (!isRecord(entry)) return [];
    const term = { term: clean(entry.term, MAX_NAME), rendering: clean(entry.rendering, MAX_NAME) };
    return term.term !== "" && written(term.rendering) ? [term] : [];
  });
  return {
    characters: unique(people, (one) => one.name).slice(0, MAX_ENTRIES.characters),
    address: unique(pairs, (one) => `${one.from}\n${one.to}`).slice(0, MAX_ENTRIES.address),
    glossary: unique(terms, (one) => one.term).slice(0, MAX_ENTRIES.glossary),
  };
}

/** The sheet `value` holds, or null when it is not one: no narrator line, or a list that is not a list. */
function readStyle(value: unknown, lang: LangCode): BookStyle | null {
  if (!isRecord(value)) return null;
  const narrator = clean(value.narrator, MAX_NARRATOR, true);
  const lists = narrator === "" ? null : readLists(value, lang);
  if (!lists) return null;
  const seen = Array.isArray(value.seen) ? value.seen.filter((name): name is string => typeof name === "string") : [];
  return { lang, narrator, ...lists, seen: seen.slice(-MAX_ENTRIES.seen) };
}

/** What the book's file holds, as the sheet in `lang`. Null when it holds none, or one made for another language. */
export function readStoredStyle(value: unknown, lang: LangCode): BookStyle | null {
  return isRecord(value) && value.lang === lang ? readStyle(value, lang) : null;
}

/** The first JSON object in a model's reply, which may be fenced or have a sentence around it despite the prompt. */
function jsonObjectIn(reply: string): Record<string, unknown> | null {
  const text = reply.trim();
  const candidates = [/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text)?.[1] ?? text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/** A new sheet from the model's reply, or null when the reply is not the shape the prompt asked for. */
export function parseStyleReply(reply: string, lang: LangCode): BookStyle | null {
  const object = jsonObjectIn(reply);
  const style = object && readStyle(object, lang);
  return style && { ...style, seen: [] };
}

/** What the model's reply adds to a sheet, or null when the reply is not the shape the prompt asked for. */
export function parseAdditions(reply: string, lang: LangCode): Lists | null {
  const object = jsonObjectIn(reply);
  return object && readLists(object, lang);
}

/** `style` with what `more` adds: an entry the sheet already has is left as it is, so a fixed rendering never changes. */
export function addToStyle(style: BookStyle, more: Lists, seen: string[]): BookStyle {
  return {
    ...style,
    characters: unique([...style.characters, ...more.characters], (one) => one.name).slice(0, MAX_ENTRIES.characters),
    address: unique([...style.address, ...more.address], (one) => `${one.from}\n${one.to}`).slice(0, MAX_ENTRIES.address),
    glossary: unique([...style.glossary, ...more.glossary], (one) => one.term).slice(0, MAX_ENTRIES.glossary),
    seen: [...new Set([...style.seen, ...seen])].slice(-MAX_ENTRIES.seen),
  };
}

// ---- The notes a prompt carries ----

// Words that start with a capital in the middle of a sentence without being anyone's name.
const NOT_NAMES = new Set(
  "mr mrs ms miss dr sir lady lord madam the god english french german latin monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december".split(" "),
);

/** The letters and digits of `text`, split into lowercase words. */
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** The words of a name or term that identify it: not a title, and not so short that it matches by accident. */
const keyWordsOf = (name: string): string[] => wordsOf(name).filter((word) => word.length >= 3 && !NOT_NAMES.has(word));

export type NotesOptions = {
  /** The text the notes go with. Only the entries whose names appear in it are kept, so a short passage gets a short note. */
  text?: string;
  /** Only names and terms, with no narrator line and no respect levels: for a single tapped word. */
  wordsOnly?: boolean;
};

/**
 * The notes for a prompt: a compact section (at most MAX_NOTES_CHARS) that the translation prompts of a book carry verbatim,
 * or "" when there is nothing to say. Respect levels come first when the room is short, since they are what goes wrong most.
 * With `text`, names and terms are kept only when they appear in it; respect levels are all kept, those of its people first.
 */
export function styleNotes(style: BookStyle | null | undefined, options: NotesOptions = {}): string {
  if (!style) return "";
  const pronouns = PRONOUNS[style.lang];
  const words = options.text === undefined ? null : new Set(wordsOf(options.text));
  // The narrator is in every passage, so what involves them always counts.
  const appears = (name: string): boolean => {
    const keys = keyWordsOf(name);
    return words === null || /\bnarrator\b/i.test(name) || keys.some((key) => words.has(key));
  };

  // The speaker is often not named within a few paragraphs ("Miss Bennet, do you know who I am?"), and a pair is a short
  // line: those of the people in the passage come first, and the others follow while there is room.
  const pairs = options.wordsOnly || !pronouns ? [] : style.address;
  const inPassage = pairs.filter((pair) => appears(pair.from) || appears(pair.to));
  const respect = [...inPassage, ...pairs.filter((pair) => !inPassage.includes(pair))].map((pair) => `${pair.from} to ${pair.to}: ${pronouns?.[pair.level]}`);
  const names = style.characters
    .filter((person) => appears(person.name))
    .map((person) => `${person.name} = ${person.rendering}${person.role ? ` (${person.role})` : ""}`);
  const terms = style.glossary.filter((one) => appears(one.term)).map((one) => `${one.term} = ${one.rendering}`);

  const lines = (kept: { respect: string[]; names: string[]; terms: string[] }): string => {
    const parts = [
      ...(options.wordsOnly ? [] : [`Voice: ${style.narrator}`]),
      ...(kept.respect.length > 0 ? [`Respect: ${kept.respect.join("; ")}`] : []),
      ...(kept.names.length > 0 ? [`Names: ${kept.names.join("; ")}`] : []),
      ...(kept.terms.length > 0 ? [`Terms: ${kept.terms.join("; ")}`] : []),
    ];
    return parts.length === 0 ? "" : ["Translator's notes for this book, to follow in every line:", ...parts].join("\n");
  };

  // One entry at a time, a kind after a kind, until the next would not fit.
  const kept = { respect: [] as string[], names: [] as string[], terms: [] as string[] };
  const queues = [
    { kind: "respect", items: respect },
    { kind: "names", items: names },
    { kind: "terms", items: terms },
  ] as const;
  for (let round = 0; queues.some(({ items }) => round < items.length); round += 1) {
    for (const { kind, items } of queues) {
      const item = items[round];
      if (item === undefined || lines({ ...kept, [kind]: [...kept[kind], item] }).length > MAX_NOTES_CHARS) continue;
      kept[kind].push(item);
    }
  }
  return lines(kept);
}

// ---- A sample of the book, and the names in it ----

const isMainChapter = (chapter: Chapter): boolean => (chapter.kind ?? "body") === "body";
const paragraphsOf = (chapter: Chapter): string[] =>
  chapter.blocks.filter((block) => block.type === "paragraph" && block.text.trim() !== "").map((block) => block.text.trim());
const isTalk = (paragraph: string): boolean => /["\u201C\u201D]/.test(paragraph);

/** The run of neighbouring paragraphs, within `budget` characters, with the most talk in it; a run keeps an exchange whole. */
function talkiestRun(paragraphs: string[], budget: number): string[] {
  let best: string[] = [];
  let bestTalk = -1;
  for (let from = 0; from < paragraphs.length; from += 1) {
    let used = 0;
    let talk = 0;
    let to = from;
    while (to < paragraphs.length && used + paragraphs[to]!.length <= budget) {
      used += paragraphs[to]!.length;
      talk += isTalk(paragraphs[to]!) ? 1 : 0;
      to += 1;
    }
    if (to > from && talk > bestTalk) {
      best = paragraphs.slice(from, to);
      bestTalk = talk;
    }
  }
  // Every paragraph is longer than the budget: the start of the first stands for the chapter.
  const first = paragraphs[0];
  return best.length > 0 || first === undefined ? best : [first.slice(0, budget)];
}

/** At most `count` of `items`, spread evenly from the first to the last. */
function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, at) => items[Math.round((at * (items.length - 1)) / (count - 1))]!);
}

function excerptsOf(chapters: Chapter[], budget: number): string {
  const chosen = spread(chapters, MAX_SAMPLED_CHAPTERS);
  const each = Math.min(MAX_CHAPTER_SAMPLE_CHARS, Math.floor(budget / Math.max(chosen.length, 1)));
  return chosen
    .map((chapter) => [`## ${chapter.title}`, ...talkiestRun(paragraphsOf(chapter), each)].join("\n\n"))
    .filter((excerpt) => excerpt.includes("\n\n"))
    .join("\n\n");
}

/** The parts of the book a style sheet is made from: the most talkative stretch of each of up to 12 chapters spread across it. */
export function styleSample(book: ParsedBook, budget = SAMPLE_CHARS): string {
  const main = book.chapters.filter(isMainChapter);
  return excerptsOf(main.length > 0 ? main : book.chapters, budget);
}

/** Capitalised words in the middle of sentences, by how often, in the order first met. A sentence's first word is left out: any word starts one. */
function capitalisedWords(chapters: Chapter[]): Map<string, { shown: string; count: number }> {
  const counts = new Map<string, { shown: string; count: number }>();
  for (const chapter of chapters) {
    for (const paragraph of paragraphsOf(chapter)) {
      for (const [shown] of paragraph.matchAll(/(?<=[\p{Ll},;:]\s)\p{Lu}\p{Ll}{2,}/gu)) {
        const key = shown.toLowerCase();
        if (NOT_NAMES.has(key)) continue;
        const entry = counts.get(key) ?? { shown, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
  }
  return counts;
}

const mostOften = (counts: Map<string, { shown: string; count: number }>, min: number, limit: number) =>
  [...counts.entries()].filter(([, { count }]) => count >= min).sort((a, b) => b[1].count - a[1].count).slice(0, limit);

/** The names that recur in the book, most often first, for the model to check its sample against. */
export function recurringNames(book: ParsedBook): { key: string; label: string }[] {
  const main = book.chapters.filter(isMainChapter);
  return mostOften(capitalisedWords(main.length > 0 ? main : book.chapters), 3, RECURRING_NAMES).map(([key, { shown, count }]) => ({ key, label: `${shown} (${count})` }));
}

/** The names `chapter` repeats that the sheet has never been shown and does not hold: what a new chapter brings. */
export function newNames(chapter: Chapter, style: BookStyle): string[] {
  const known = new Set([...style.seen, ...style.characters.flatMap((one) => wordsOf(one.name)), ...style.glossary.flatMap((one) => wordsOf(one.term))]);
  return mostOften(capitalisedWords([chapter]), NEW_NAME_MIN_COUNT, NEW_NAMES).filter(([key]) => !known.has(key)).map(([, { shown }]) => shown);
}

// ---- Making the sheet, and keeping it ----

/** Where a book's sheet is kept: with the book, in its owner's library. */
export type StyleStore = Pick<Library, "readStyle" | "writeStyle">;

export type StyleRequest = {
  library: StyleStore;
  bookId: string;
  book: ParsedBook;
  lang: LangCode;
  /** The AI helper that makes the sheet. */
  helper: Llm;
  /** The chapter about to be translated: when it repeats names the sheet has never been shown, the sheet grows. */
  chapter?: Chapter;
  signal?: AbortSignal;
};

export type StyleKeeper = {
  /** The book's sheet, or null when it has none. One read of the store, then kept: it is asked for on every tapped word. */
  style(library: StyleStore, bookId: string, lang: LangCode): Promise<BookStyle | null>;
  /**
   * The book's sheet, made if the book has none and grown if `chapter` brings names it has not seen; one at a time for a
   * book and language, so two requests never make it twice. It costs one or two requests to the AI helper, and only when
   * it makes or grows the sheet. Never rejects: null when there is no sheet and none could be made, and a failed attempt
   * is not repeated for ten minutes.
   */
  ensure(request: StyleRequest): Promise<BookStyle | null>;
};

type Remembered = { style: BookStyle | null; at: number };
type Books = { styles: Map<string, Remembered>; turns: Map<string, Promise<unknown>>; failed: Map<string, number> };

export function createStyleKeeper(options: { now?: () => number } = {}): StyleKeeper {
  const now = options.now ?? Date.now;
  // By library, then book and language: a library is one reader's books, and a test's is its own.
  const books = new WeakMap<object, Books>();
  const booksOf = (library: object): Books => {
    const known = books.get(library);
    if (known) return known;
    const fresh = { styles: new Map(), turns: new Map(), failed: new Map() };
    books.set(library, fresh);
    return fresh;
  };
  const keyOf = (bookId: string, lang: LangCode): string => `${bookId}\n${lang}`;

  async function style(library: StyleStore, bookId: string, lang: LangCode): Promise<BookStyle | null> {
    const { styles } = booksOf(library);
    const key = keyOf(bookId, lang);
    const held = styles.get(key);
    if (held && (held.style || now() - held.at < NO_NOTES_HOLDS_MS)) return held.style;
    const read = readStoredStyle(await library.readStyle(bookId, lang), lang);
    // A sheet made while this read was waiting is newer.
    const meanwhile = styles.get(key);
    if (meanwhile?.style) return meanwhile.style;
    styles.set(key, { style: read, at: now() });
    return read;
  }

  /** Asks the helper, and once more if the reply is not the shape asked for; null means both replies were unusable. */
  async function ask<T>(helper: Llm, prompt: { system: string; user: string }, parse: (reply: string) => T | null, signal?: AbortSignal): Promise<T | null> {
    for (const hint of ["", RETRY_HINT]) {
      const reply = await completeText(helper, { task: "style", system: prompt.system, user: prompt.user + hint, signal });
      const made = parse(reply);
      if (made) return made;
    }
    return null;
  }

  const contextOf = (request: StyleRequest, sample: string): StyleSheetContext => ({
    bookTitle: request.book.title,
    author: request.book.author,
    language: LANGUAGES[request.lang],
    levels: PRONOUNS[request.lang] ?? null,
    script: SCRIPTS[request.lang]?.name ?? null,
    sample,
  });

  async function make(request: StyleRequest): Promise<BookStyle | null> {
    const sample = styleSample(request.book);
    if (sample === "") return null;
    const names = recurringNames(request.book);
    const prompt = styleSheetPrompt({ ...contextOf(request, sample), names: names.map((name) => name.label) });
    const made = await ask(request.helper, prompt, (reply) => parseStyleReply(reply, request.lang), request.signal);
    // A recurring name the sample never reached was only named to the model, not shown: its first chapter shows it.
    const shown = new Set(wordsOf(sample));
    return made && { ...made, seen: names.map((name) => name.key).filter((key) => shown.has(key)) };
  }

  async function grow(request: StyleRequest, current: BookStyle): Promise<BookStyle | null> {
    const names = request.chapter ? newNames(request.chapter, current) : [];
    if (!request.chapter || names.length === 0) return current;
    const sample = excerptsOf([request.chapter], GROW_SAMPLE_CHARS);
    const prompt = styleAdditionsPrompt({ ...contextOf(request, sample), notes: styleNotes(current), newNames: names });
    const more = await ask(request.helper, prompt, (reply) => parseAdditions(reply, request.lang), request.signal);
    return more && addToStyle(current, more, names.map((name) => name.toLowerCase()));
  }

  async function work(request: StyleRequest): Promise<BookStyle | null> {
    const { library, bookId, lang, signal } = request;
    const state = booksOf(library);
    const key = keyOf(bookId, lang);
    let current: BookStyle | null = null;
    try {
      current = await style(library, bookId, lang);
      const failedAt = state.failed.get(key);
      if (failedAt !== undefined && now() - failedAt < FAILURE_COOLDOWN_MS) return current;
      const next = current ? await grow(request, current) : await make(request);
      if (!next) throw new Error("no usable style sheet came back");
      if (next !== current) {
        state.styles.set(key, { style: next, at: now() });
        await library.writeStyle(bookId, lang, next);
      }
      return next;
    } catch (error) {
      // A request the reader cancelled is not a failure of the helper.
      if (signal?.aborted) return current;
      state.failed.set(key, now());
      console.warn(`could not make the translator's notes of ${bookId} in ${lang}:`, error instanceof Error ? error.message : error);
      return current;
    }
  }

  return {
    style,
    ensure(request) {
      const { turns } = booksOf(request.library);
      const key = keyOf(request.bookId, request.lang);
      const turn = (turns.get(key) ?? Promise.resolve()).then(() => work(request));
      turns.set(key, turn);
      void turn.then(() => {
        if (turns.get(key) === turn) turns.delete(key);
      });
      return turn;
    },
  };
}

/** The keeper every route uses, so a sheet made while one chapter is translating is the one a tapped line finds. */
export const bookStyles: StyleKeeper = createStyleKeeper();
