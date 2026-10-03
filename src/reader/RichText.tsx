import type { ReactNode } from "react";

export type RichBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };

/** A labelled part of an answer, e.g. "Deeper meaning". Text before the first label has no label. */
export type RichSection = { label: string | null; blocks: RichBlock[] };

export type GlossaryEntry = {
  term: string;
  /** A note attached to the term, such as how to say it. */
  hint: string | null;
  meaning: string;
  /** The meaning in the reader's own language. */
  native: string | null;
};

// "**In context:** text" or "**In context**: text". The colon is required so that a sentence which
// merely starts with a bold word is not mistaken for a label.
const LABEL = /^\*\*([^*]{1,40}?)(?::\*\*|\*\*:)\s*(.*)$/;
// A label that is still streaming in ("**In con"): show it as a label right away instead of raw asterisks.
const OPEN_LABEL = /^\*\*([^*]{0,40})$/;
const LIST_ITEM = /^[-*\u2022]\s+(.*)$/;

/** The tutor writes plain text with bold labels, "- " lists and **bold**; group it into sections. */
export function parseSections(text: string): RichSection[] {
  const sections: RichSection[] = [];
  const open = (label: string | null): RichSection => {
    const section: RichSection = { label, blocks: [] };
    sections.push(section);
    return section;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const label = LABEL.exec(line);
    if (label) {
      const section = open((label[1] ?? "").trim());
      if (label[2]) section.blocks.push({ type: "p", text: label[2] });
      continue;
    }
    const partial = OPEN_LABEL.exec(line);
    if (partial) {
      open((partial[1] ?? "").replace(/:$/, "").trim());
      continue;
    }
    const section = sections.at(-1) ?? open(null);
    const item = LIST_ITEM.exec(line);
    const last = section.blocks.at(-1);
    if (!item) section.blocks.push({ type: "p", text: line });
    else if (last?.type === "ul") last.items.push(item[1] ?? "");
    else section.blocks.push({ type: "ul", items: [item[1] ?? ""] });
  }
  return sections;
}

/** Split a hard-word line such as "minute (say my-NOOT) - very small (native words)". */
export function parseGlossaryEntry(item: string): GlossaryEntry | null {
  const split = /^(.+?)\s+[-\u2013\u2014:]\s+(.+)$/.exec(item.replaceAll("*", ""));
  if (!split?.[1] || !split[2]) return null;
  const termParts = /^(.*?)\s*\((.+)\)$/.exec(split[1].trim());
  const meaningParts = /^(.*?)\s*\(([^()]*)\)\.?$/.exec(split[2].trim());
  // Only a bracket written in another script is the native meaning; an English aside stays in the meaning.
  const hasNative = meaningParts?.[2] !== undefined && /[^\x00-\x7F]/.test(meaningParts[2]);
  return {
    term: (termParts?.[1] ?? split[1]).trim(),
    hint: termParts?.[2]?.trim() ?? null,
    meaning: (hasNative ? (meaningParts[1] ?? "") : split[2]).trim(),
    native: hasNative ? (meaningParts[2] ?? "").trim() : null,
  };
}

type SectionKind = "deep" | "glossary" | "translation" | "plain";

function kindOf(label: string | null): SectionKind {
  if (!label) return "plain";
  if (/deeper/i.test(label)) return "deep";
  if (/hard words/i.test(label)) return "glossary";
  if (/translation/i.test(label)) return "translation";
  return "plain";
}

// **bold**, then *italic* or _italic_. The end of the line also closes one, so an emphasis still streaming in
// ("you *belie") never shows its asterisks. A star with a space after it ("2 * 3") is just a star.
const EMPHASIS = /\*\*(.*?)(?:\*\*|$)|(?<![\w*])\*(?=[^\s*]|$)(.*?)(?:\*|$)|(?<!\w)_(?=[^\s_]|$)(.*?)(?:_(?!\w)|$)/g;

/** One line of the AI's text with its emphasis shown as bold or italic instead of the marks it typed. */
export function inline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    const [whole, bold, italic = match[3]] = match;
    parts.push(text.slice(from, match.index));
    parts.push(bold === undefined ? <em key={match.index}>{italic}</em> : <strong key={match.index}>{bold}</strong>);
    from = match.index + whole.length;
  }
  parts.push(text.slice(from));
  return parts;
}

/** `end` follows the meaning in the last row. */
function Glossary({ items, end }: { items: string[]; end: ReactNode }) {
  return (
    <dl className="glossary">
      {items.map((item, i) => {
        const entry = parseGlossaryEntry(item);
        const tail = i === items.length - 1 && end;
        if (!entry) {
          return (
            <div className="glossary-row glossary-row-plain" key={i}>
              <dd>
                {inline(item)}
                {tail}
              </dd>
            </div>
          );
        }
        return (
          <div className="glossary-row" key={i}>
            <dt>
              {entry.term}
              {entry.hint && <span className="glossary-hint">{entry.hint}</span>}
            </dt>
            <dd>
              {entry.meaning}
              {entry.native && <span className="glossary-native">{entry.native}</span>}
              {tail}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** `writing` means the answer is still streaming in. */
export function RichText({ text, writing = false }: { text: string; writing?: boolean }) {
  const sections = parseSections(text);
  // Quiet dots after the last word until the answer is complete, so a half answer never passes for a whole one.
  // A space, not a margin, sets them apart: it collapses into a space the text already ends with, and if the dots
  // wrap, it stays behind at the end of the line so they start flush with the text.
  const dots = writing && (
    <>
      {" "}
      <span className="writing" aria-hidden />
    </>
  );
  return (
    <div className="rich">
      {sections.map((section, i) => {
        const kind = kindOf(section.label);
        const last = i === sections.length - 1;
        const end = (j: number) => last && j === section.blocks.length - 1 && dots;
        return (
          <section className="rich-section" data-kind={kind} key={i}>
            {section.label && (
              <h3 className="rich-label">
                <span>{section.label}</span>
                {last && section.blocks.length === 0 && dots}
              </h3>
            )}
            {section.blocks.map((block, j) =>
              block.type === "p" ? (
                <p key={j}>
                  {inline(block.text)}
                  {end(j)}
                </p>
              ) : kind === "glossary" ? (
                <Glossary key={j} items={block.items} end={end(j)} />
              ) : (
                <ul key={j}>
                  {block.items.map((item, k) => (
                    <li key={k}>
                      {inline(item)}
                      {k === block.items.length - 1 && end(j)}
                    </li>
                  ))}
                </ul>
              ),
            )}
          </section>
        );
      })}
    </div>
  );
}
