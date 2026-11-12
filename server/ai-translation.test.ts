// What a model's answer is checked for before it is kept as a translation, and the one more question when it fails the check.
import { describe, expect, it } from "vitest";
import { chapterTranslationPrompt, planBatches, readSections, translateBatch, whyNotTranslation } from "./ai-translation.ts";
import { LlmError } from "./llm.ts";
import type { Llm } from "./llm.ts";

const ENGLISH = "The real table, if it exists, we will call a physical object. It is not what we see at once.";

describe("whyNotTranslation", () => {
  it("should refuse an answer that is empty, still English, or far shorter or longer than the paragraph, and accept a Bangla one", () => {
    const bangla = "আসল টেবিলটি, যদি তার অস্তিত্ব থাকে, আমরা তাকে বলব একটি বস্তুগত বস্তু। আমরা প্রথম দেখায় যা দেখি, এটি তা নয়।";
    expect(whyNotTranslation(ENGLISH, bangla, "bn")).toBeNull();
    expect(whyNotTranslation(ENGLISH, "", "bn")).toBe("it was empty");
    expect(whyNotTranslation(ENGLISH, ENGLISH, "bn")).toContain("still mostly English");
    expect(whyNotTranslation(ENGLISH, "টেবিল।", "bn")).toContain("far shorter");
    expect(whyNotTranslation(ENGLISH, bangla.repeat(5), "bn")).toContain("far longer");
    // A translation that stops before its last sentence ends, though it is long enough not to look short; a heading has no end mark to need.
    expect(whyNotTranslation(ENGLISH, bangla.slice(0, -1), "bn")).toContain("stopped before the end");
    expect(whyNotTranslation("The Problems of Philosophy", "দর্শনের সমস্যাবলি", "bn")).toBeNull();
    // A Latin-script language is told apart from English by being the same text, not by its letters.
    expect(whyNotTranslation(ENGLISH, ENGLISH, "fr")).toContain("English text");
    expect(whyNotTranslation(ENGLISH, "La vraie table, si elle existe, nous l'appellerons un objet physique. Ce n'est pas ce que nous voyons.", "fr")).toBeNull();
  });
});

describe("translateBatch", () => {
  const GOOD = (id: string) => `=== ${id} ===\n${id} এর অনুবাদ এখানে আছে, ঠিকঠাক।`;
  const END = "=== end ===";
  const paragraphs = ["First paragraph here.", "Second paragraph here.", "Third paragraph here."].map((text, at) => ({ id: `b${at + 1}`, text }));

  /** A helper that answers with `replies` in turn, and keeps what it was asked. */
  function replying(replies: string[]) {
    const asks: string[] = [];
    const llm: Llm = {
      model: () => "fake",
      streamText: (request) =>
        (async function* () {
          asks.push(request.user);
          yield replies[asks.length - 1] ?? "";
        })(),
    };
    return { llm, asks };
  }
  const batch = (llm: Llm) => translateBatch({ llm, lang: "bn", book: { title: "T", author: null }, chapterTitle: "One", before: [], paragraphs });

  it("should ask again only for a paragraph that was missing or sent twice, and say why", async () => {
    const { llm, asks } = replying([`${GOOD("b1")}\n\n${GOOD("b3")}\n\n${GOOD("b3")}\n\n${END}`, `${GOOD("b2")}\n\n${GOOD("b3")}\n\n${END}`]);
    const result = await batch(llm);
    expect(asks).toHaveLength(2);
    expect(asks[1]).toContain("b2: it was missing from the reply");
    expect(asks[1]).toContain("b3: it appeared twice in the reply");
    expect(asks[1]).not.toContain("b1:");
    expect([...result.made.keys()].sort()).toEqual(["b1", "b2", "b3"]);
    expect(result.failed.size).toBe(0);
  });

  it("should keep what the first answer got right when the second question fails, and say the others were never answered", async () => {
    let asks = 0;
    const llm: Llm = {
      model: () => "fake",
      streamText: () =>
        (async function* () {
          asks += 1;
          if (asks === 2) throw new LlmError("timeout", "The AI took too long to answer. Please try again.");
          yield `${GOOD("b1")}\n\n${GOOD("b3")}\n\n${END}`;
        })(),
    };
    const result = await batch(llm);
    expect(asks).toBe(2);
    expect([...result.made.keys()]).toEqual(["b1", "b3"]);
    // b2 was not refused by the helper: it was never answered, so nothing says the helper is no good at that text.
    expect(result.failed.size).toBe(0);
    expect(result.error?.kind).toBe("timeout");
  });

  it("should not take a note after the closing line for part of the last paragraph, and not trust the last paragraph of an answer that never closed", async () => {
    const noted = replying([`${GOOD("b1")}\n\n${GOOD("b2")}\n\n${GOOD("b3")}\n\n${END}\n\nNote: I used the polite form here because the narrator speaks to the listener as an equal.`]);
    const first = await batch(noted.llm);
    expect(noted.asks).toHaveLength(1);
    expect(first.made.get("b3")).not.toContain("Note:");

    // An answer cut short has no closing line: what came before the last paragraph stands, and the last is asked again.
    const cut = replying([`${GOOD("b1")}\n\n${GOOD("b2")}\n\n${GOOD("b3")}`, `${GOOD("b3")}\n\n${END}`]);
    const second = await batch(cut.llm);
    expect(cut.asks).toHaveLength(2);
    expect(cut.asks[1]).toContain("b3: the reply did not end with");
    expect(cut.asks[1]).not.toContain("b1:");
    expect([...second.made.keys()].sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("should believe none of a reply that has a marker nobody asked for, and report what still fails after the second try", async () => {
    const stray = `${GOOD("b1")}\n\n${GOOD("b2")}\n\n${GOOD("b3")}\n\n${GOOD("extra")}\n\n${END}`;
    const { llm, asks } = replying([stray, stray]);
    const result = await batch(llm);
    expect(asks).toHaveLength(2);
    expect(result.made.size).toBe(0);
    expect([...result.failed.keys()]).toEqual(["b1", "b2", "b3"]);
    expect(result.failed.get("b1")).toBe('the reply had a marker "extra" that was not asked for');
  });
});

describe("chapterTranslationPrompt and planBatches", () => {
  it("should tell the helper the book, the register of address and the Bangla before, and cut a first small batch", () => {
    const prompt = chapterTranslationPrompt({
      lang: "bn",
      book: { title: "Heart of Darkness", author: "Joseph Conrad" },
      chapterTitle: "I",
      style: "Marlow is old and speaks to the listeners as equals.",
      before: [{ text: "He nodded.", translation: "সে মাথা নাড়ল।" }],
      paragraphs: [{ id: "c1-b3", text: "Good-bye, old man." }],
    });
    expect(prompt.system).toContain("আপনি");
    expect(prompt.system).toContain("তুই");
    expect(prompt.user).toContain('Book: "Heart of Darkness" by Joseph Conrad.');
    expect(prompt.user).toContain("Marlow is old");
    expect(prompt.user).toContain("[English] He nodded.\n[Bangla] সে মাথা নাড়ল।");
    expect(prompt.user.endsWith("=== c1-b3 ===\nGood-bye, old man.")).toBe(true);

    const items = Array.from({ length: 6 }, () => ({ text: "x".repeat(1_000) }));
    expect(planBatches(items).map((batch) => batch.length)).toEqual([1, 4, 1]);
    expect(readSections("```\n=== a ===\none\n=== a ===\ntwo\n=== b ===\nthree\n```")).toEqual(new Map([["a", null], ["b", "three"]]));
  });
});
