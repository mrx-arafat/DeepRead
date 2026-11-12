// The translator's style sheet: what its notes carry into a prompt, which model replies it accepts, and that it is made once,
// kept with the book, and only ever added to. The AI helper is a fake and the library is real, on disk in a temp dir.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Chapter, ParsedBook } from "../shared/types.ts";
import { createLibrary } from "./library.ts";
import type { Library } from "./library.ts";
import type { Llm, LlmRequest } from "./llm.ts";
import { createStyleKeeper, MAX_NOTES_CHARS, parseAdditions, parseStyleReply, readStoredStyle, styleNotes } from "./translation-style.ts";
import type { BookStyle } from "./translation-style.ts";

const SHEET = {
  narrator: "Marlow tells it in the first person, plain and reflective, in natural চলিত.",
  characters: [
    { name: "Marlow", rendering: "মার্লো", role: "the narrator" },
    { name: "Kurtz", rendering: "কুর্টজ", role: "an ivory agent" },
  ],
  address: [
    { from: "Marlow", to: "the Manager", level: "formal", why: "rank" },
    { from: "the Manager", to: "Marlow", level: "familiar", why: "senior to junior" },
    { from: "Kurtz", to: "Marlow", level: "familiar", why: "friends" },
  ],
  glossary: [{ term: "the Company", rendering: "কোম্পানি" }],
};

const style = (lang: "bn" | "es" = "bn"): BookStyle => parseStyleReply(JSON.stringify(SHEET), lang) as BookStyle;

describe("styleNotes", () => {
  it("should stay within the limit however big the sheet, and keep the first entry of each kind", () => {
    const many: BookStyle = {
      ...style(),
      characters: Array.from({ length: 30 }, (_, at) => ({ name: `Person${at}`, rendering: `ব্যক্তি${at}`, role: "someone who matters to the story" })),
      address: Array.from({ length: 40 }, (_, at) => ({ from: `Person${at}`, to: `Person${at + 1}`, level: "familiar" as const, why: "friends" })),
      glossary: Array.from({ length: 40 }, (_, at) => ({ term: `Term${at}`, rendering: `শব্দ${at}` })),
    };
    const notes = styleNotes(many);
    expect(notes.length).toBeLessThanOrEqual(MAX_NOTES_CHARS);
    expect(notes).toContain("Person0 to Person1: তুমি");
    expect(notes).toContain("Person0 = ব্যক্তি0 (someone who matters to the story)");
    expect(notes).toContain("Term0 = শব্দ0");
    expect(notes).not.toContain("Person39");
  });

  it("should give a passage only what it mentions, and a tapped word only names and terms", () => {
    const sheet = style();
    expect(styleNotes(sheet)).toBe(
      [
        "Translator's notes for this book, to follow in every line:",
        `Voice: ${SHEET.narrator}`,
        "Respect: Marlow to the Manager: আপনি; the Manager to Marlow: তুমি; Kurtz to Marlow: তুমি",
        "Names: Marlow = মার্লো (the narrator); Kurtz = কুর্টজ (an ivory agent)",
        "Terms: the Company = কোম্পানি",
      ].join("\n"),
    );
    // Kurtz and the Company are not in this passage, so their spelling and rendering are left out. Who addresses whom is not:
    // the speaker is often unnamed, so the pairs of the passage's people come first and the others follow.
    const passage = styleNotes(sheet, { text: "The Manager looked at Marlow, and Marlow said nothing." });
    expect(passage).toContain("Respect: Marlow to the Manager: আপনি; the Manager to Marlow: তুমি; Kurtz to Marlow: তুমি");
    expect(passage).toContain("Names: Marlow = মার্লো (the narrator)");
    expect(passage).not.toMatch(/কুর্টজ|Company/);
    expect(styleNotes(sheet, { text: "Nobody I know." })).toContain("Kurtz to Marlow: তুমি");
    expect(styleNotes(sheet, { text: "the Company", wordsOnly: true })).toBe("Translator's notes for this book, to follow in every line:\nTerms: the Company = কোম্পানি");
    expect(styleNotes(sheet, { text: "table", wordsOnly: true })).toBe("");
    expect(styleNotes(null)).toBe("");
  });
});

describe("a model's reply", () => {
  it("should be accepted fenced or with a sentence around it, and refused when it is not the shape asked for", () => {
    const reply = JSON.stringify(SHEET);
    expect(parseStyleReply(`Here it is:\n\`\`\`json\n${reply}\n\`\`\``, "bn")?.characters).toHaveLength(2);
    expect(parseStyleReply(`Sure. ${reply} Done.`, "bn")?.glossary).toHaveLength(1);
    expect(parseStyleReply("I cannot do that.", "bn")).toBeNull();
    expect(parseStyleReply(JSON.stringify({ ...SHEET, narrator: "" }), "bn")).toBeNull();
    expect(parseStyleReply(JSON.stringify({ ...SHEET, characters: "Marlow" }), "bn")).toBeNull();
    expect(parseAdditions(JSON.stringify({ characters: {} }), "bn")).toBeNull();
  });

  it("should lose the entries that are not whole, left in English, or at a level there is none of", () => {
    const parsed = parseStyleReply(
      JSON.stringify({
        ...SHEET,
        characters: [...SHEET.characters, { name: "Fresleven", rendering: "Fresleven", role: "a Dane" }, { name: "", rendering: "অজানা" }],
        address: [...SHEET.address, { from: "Kurtz", to: "Marlow", level: "rude", why: "" }, { from: "Marlow", to: "Marlow", level: "formal", why: "" }],
      }),
      "bn",
    );
    expect(parsed?.characters.map((one) => one.name)).toEqual(["Marlow", "Kurtz"]);
    expect(parsed?.address).toHaveLength(3);
    // A narrator line that runs long is cut between words, since it is sent to every prompt as it is kept.
    const long = parseStyleReply(JSON.stringify({ ...SHEET, narrator: "plainly spoken ".repeat(30) }), "bn")?.narrator;
    expect(long?.length).toBeLessThanOrEqual(200);
    expect(long?.endsWith("plainly") || long?.endsWith("spoken")).toBe(true);
    // A language that has no respect levels keeps no pairs.
    expect(parseStyleReply(JSON.stringify(SHEET), "id")?.address).toEqual([]);
  });

  it("should be read back from the book's file only for the language it was made for", () => {
    expect(readStoredStyle(style(), "bn")).toEqual(style());
    expect(readStoredStyle(style(), "hi")).toBeNull();
    expect(readStoredStyle({ lang: "bn", narrator: "x", characters: null }, "bn")).toBeNull();
  });
});

describe("createStyleKeeper", () => {
  let dataDir: string;
  let library: Library;
  let bookId: string;

  const paragraph = (id: string, text: string) => ({ id, type: "paragraph" as const, text, page: 1 });
  const chapter = (id: string, texts: string[]): Chapter => ({
    id,
    title: `Chapter ${id}`,
    startPage: 1,
    endPage: 1,
    blocks: texts.map((text, at) => paragraph(`${id}-b${at}`, text)),
  });
  const book: ParsedBook = {
    title: "Heart of Darkness",
    author: "Joseph Conrad",
    pageCount: 1,
    warnings: [],
    chapters: [
      chapter("c1", [
        'Then the Manager said to Marlow, "You will go up the river." And Marlow, who had met Kurtz once, thought of Kurtz and the Company.',
        '"I will go," said Marlow. "The Company is paying, and Marlow goes where the Company sends him."',
        "Marlow looked at Kurtz and then at the river.",
      ]),
    ],
  };
  // A chapter the sample did not reach, which brings a name the model was never shown.
  const later = chapter("c9", ["They asked Fresleven to wait.", "They said Fresleven was dead, and Fresleven was a Dane."]);

  /** A helper that answers each request with the next reply, and keeps the requests. */
  function helper(replies: string[]) {
    const requests: LlmRequest[] = [];
    const llm: Llm = {
      model: () => "fake",
      async *streamText(request) {
        requests.push(request);
        yield replies[Math.min(requests.length - 1, replies.length - 1)] ?? "";
      },
    };
    return { llm, requests };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-translation-style-"));
    library = createLibrary(dataDir);
    const uploadPath = await library.newUploadPath("book");
    await writeFile(uploadPath, "%PDF-1.4");
    ({ id: bookId } = await library.add({ uploadPath, sha256: "cd".repeat(32), parsed: book, cover: null }));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("should make the sheet once from the talkative parts, keep it with the book, and find it again after a restart", async () => {
    const { llm, requests } = helper([JSON.stringify(SHEET)]);
    const keeper = createStyleKeeper();
    const request = { library, bookId, book, lang: "bn" as const, helper: llm };

    const [first, second] = await Promise.all([keeper.ensure(request), keeper.ensure(request)]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.task).toBe("style");
    expect(requests[0]?.user).toContain('"I will go," said Marlow.');
    expect(requests[0]?.user).toContain("Marlow (");
    expect(first).toEqual(second);
    expect(first?.characters.map((one) => one.rendering)).toEqual(["মার্লো", "কুর্টজ"]);

    // Another server process, with nothing in memory, finds it in the book's file and asks the helper for nothing.
    const restarted = createStyleKeeper();
    expect(await restarted.style(createLibrary(dataDir), bookId, "bn")).toEqual(first);
    expect(await restarted.style(createLibrary(dataDir), bookId, "hi")).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("should ask again once for an unreadable reply, then give up and not ask again for ten minutes", async () => {
    let clock = 0;
    const { llm, requests } = helper(["not json", "still not json", JSON.stringify(SHEET)]);
    const keeper = createStyleKeeper({ now: () => clock });
    const request = { library, bookId, book, lang: "bn" as const, helper: llm };

    expect(await keeper.ensure(request)).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain("Your last reply could not be read");
    expect(await keeper.ensure(request)).toBeNull();
    expect(requests).toHaveLength(2);

    clock = 11 * 60_000;
    expect((await keeper.ensure(request))?.narrator).toContain("Marlow");
    expect(requests).toHaveLength(3);
  });

  it("should grow only when a chapter repeats a name it was never shown, and never change what it holds", async () => {
    const { llm, requests } = helper([
      JSON.stringify(SHEET),
      JSON.stringify({
        characters: [
          { name: "Fresleven", rendering: "ফ্রেসলেভেন", role: "a Dane" },
          { name: "Marlow", rendering: "মারলো", role: "someone else" },
        ],
      }),
    ]);
    const keeper = createStyleKeeper();
    const base = { library, bookId, book, lang: "bn" as const, helper: llm };

    await keeper.ensure({ ...base, chapter: book.chapters[0] });
    expect(requests).toHaveLength(1);

    const grown = await keeper.ensure({ ...base, chapter: later });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain("Fresleven");
    expect(grown?.characters.map((one) => `${one.name}=${one.rendering}`)).toEqual(["Marlow=মার্লো", "Kurtz=কুর্টজ", "Fresleven=ফ্রেসলেভেন"]);

    // The name has been shown now, so the chapter is not sent again.
    await keeper.ensure({ ...base, chapter: later });
    expect(requests).toHaveLength(2);
    expect(await createStyleKeeper().style(createLibrary(dataDir), bookId, "bn")).toEqual(grown);
  });
});
