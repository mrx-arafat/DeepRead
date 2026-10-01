import { Fragment, type ReactNode } from "react";

export type RichBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };

/** The tutor writes plain text with "- " lists and **bold**; group its lines into blocks. */
export function parseRich(text: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-*•]\s+(.*)$/.exec(line);
    const last = blocks.at(-1);
    if (item) {
      if (last?.type === "ul") last.items.push(item[1] ?? "");
      else blocks.push({ type: "ul", items: [item[1] ?? ""] });
    } else {
      blocks.push({ type: "p", text: line });
    }
  }
  return blocks;
}

function inline(text: string): ReactNode {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="rich">
      {parseRich(text).map((block, i) =>
        block.type === "ul" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{inline(block.text)}</p>
        ),
      )}
    </div>
  );
}
