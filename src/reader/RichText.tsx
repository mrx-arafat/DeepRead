import { Fragment, type ReactNode } from "react";

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
  const split = /^(.+?)\s+[-\u2013\u2014:]\s+(.+)$/.exec(item.replaceAll("**", ""));
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

function inline(text: string): ReactNode {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

function Glossary({ items }: { items: string[] }) {
  return (
    <dl className="glossary">
      {items.map((item, i) => {
        const entry = parseGlossaryEntry(item);
        if (!entry) {
          return (
            <div className="glossary-row glossary-row-plain" key={i}>
              <dd>{inline(item)}</dd>
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
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="rich">
      {parseSections(text).map((section, i) => {
        const kind = kindOf(section.label);
        return (
          <section className="rich-section" data-kind={kind} key={i}>
            {section.label && (
              <h3 className="rich-label">
                <span>{section.label}</span>
              </h3>
            )}
            {section.blocks.map((block, j) =>
              block.type === "p" ? (
                <p key={j}>{inline(block.text)}</p>
              ) : kind === "glossary" ? (
                <Glossary key={j} items={block.items} />
              ) : (
                <ul key={j}>
                  {block.items.map((item, k) => (
                    <li key={k}>{inline(item)}</li>
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
