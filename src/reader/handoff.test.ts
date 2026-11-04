import { describe, expect, it } from "vitest";
import { handoffLink, MAX_HANDOFF_URL_CHARS } from "./handoff.ts";

const passage = {
  bookTitle: "The Problems of Philosophy",
  author: "Bertrand Russell",
  chapterTitle: "Chapter I. Appearance and Reality",
  language: "Bangla",
  before: "The paragraph before.",
  paragraph: "To the eye it is oblong, brown and shiny. The colour depends on the light. Nothing more.",
  selection: "The colour depends on the light.",
};

const sentence = (n: number) => `Sentence number ${n} of the paragraph says a few words.`;
const sentences = (from: number, to: number) => Array.from({ length: to - from }, (_, n) => sentence(from + n)).join(" ");

describe("handoffLink", () => {
  it("should build the deep-dive prompt with the selection marked, and open the chosen chat with it", () => {
    const link = handoffLink("chatgpt", passage);
    expect(link.label).toBe("ChatGPT");
    expect(link.prompt).toContain('I am reading "The Problems of Philosophy" by Bertrand Russell, chapter "Chapter I. Appearance and Reality", in English. My first language is Bangla.');
    expect(link.prompt).toContain('"""\nThe paragraph before.\n\nTo the eye it is oblong, brown and shiny. >>The colour depends on the light.<< Nothing more.\n"""');
    expect(link.prompt).toContain("5. The hard words in the selected part, each with a simple meaning and the Bangla word in Bangla script.");
    expect(link.href).toBe(`https://chatgpt.com/?q=${encodeURIComponent(link.prompt)}`);
    expect(handoffLink("google", passage).href).toBe(`https://www.google.com/search?udm=50&q=${encodeURIComponent(link.prompt)}`);
    expect(handoffLink("copy", passage)).toMatchObject({ label: "Copy prompt", href: null, prompt: link.prompt });
    // Gemini takes no prompt in its address: the chat opens empty and the copied prompt is pasted.
    expect(handoffLink("gemini", passage)).toMatchObject({ label: "Gemini", href: "https://gemini.google.com/app", prompt: link.prompt });
    expect(handoffLink("claude", { ...passage, author: null }).prompt).toContain('I am reading "The Problems of Philosophy", chapter');
  });

  it("should cut the paragraph before, then the paragraph down to the sentences around the selection, then open empty, so the link stays short", () => {
    const whole = { ...passage, before: sentences(0, 60), paragraph: `${sentences(0, 20)} ${passage.selection} ${sentences(21, 41)}` };
    const first = handoffLink("chatgpt", whole);
    expect(first.href?.length).toBeLessThanOrEqual(MAX_HANDOFF_URL_CHARS);
    expect(first.prompt).not.toContain(`${sentence(59)}\n\n`);
    expect(first.prompt).toContain(`${sentence(0)} `);
    expect(first.prompt).toContain(` ${sentence(40)}\n"""`);

    const tight = handoffLink("chatgpt", { ...whole, paragraph: `${sentences(0, 80)} ${passage.selection} ${sentences(81, 161)}` });
    expect(tight.href?.length).toBeLessThanOrEqual(MAX_HANDOFF_URL_CHARS);
    expect(tight.prompt).toContain(`"""\n${sentence(79)} >>${passage.selection}<< ${sentence(81)}\n"""`);

    // The selection itself is never cut: when it alone is too long, the chat opens empty and the copied prompt carries it whole.
    const selection = "word ".repeat(1500).trim();
    const pasted = handoffLink("chatgpt", { ...passage, selection, paragraph: selection });
    expect(pasted.href).toBe("https://chatgpt.com/");
    expect(pasted.prompt).toContain(`>>${selection}<<`);
  });
});
