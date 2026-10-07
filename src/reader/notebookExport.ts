import type { BookDetail, Note } from "../../shared/types.ts";

type ExportInput = {
  book: Pick<BookDetail, "title" | "author" | "chapters">;
  entries: readonly Note[];
  selectedIds: ReadonlySet<string>;
};

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()#+\-.!|]/g, "\\$&");
}

function singleLine(value: string): string {
  return escapeMarkdown(value.replace(/\s+/g, " ").trim());
}

function body(value: string): string {
  return escapeMarkdown(value.replace(/\r\n?/g, "\n"));
}

function quote(value: string): string {
  return body(value)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Format selected reader-owned notebook material as a standalone Markdown document. */
export function exportNotebookMarkdown({ book, entries, selectedIds }: ExportInput): string {
  const chapters = new Map(book.chapters.map((chapter) => [chapter.id, chapter.title]));
  const lines = [`# ${singleLine(book.title)}`, ...(book.author ? [`By ${singleLine(book.author)}`] : []), ""];
  let lastChapter: string | null = null;

  for (const entry of entries) {
    if (!selectedIds.has(entry.id)) continue;
    if (entry.mode !== "highlight" && entry.mode !== "reflection" && !entry.savedAnswer?.trim()) continue;

    if (entry.chapterId !== lastChapter) {
      lines.push(`## ${singleLine(chapters.get(entry.chapterId) ?? entry.chapterId)}`, "");
      lastChapter = entry.chapterId;
    }

    const offset = "offset" in entry && typeof entry.offset === "number" ? entry.offset : "not recorded";
    const location = `Source: chapter: ${singleLine(entry.chapterId)}; block: ${singleLine(entry.blockId)}; offset: ${offset}`;
    if (entry.mode === "highlight") {
      lines.push("### Highlight", "", "Book quote:", quote(entry.quote), "", location, "");
    } else if (entry.mode === "reflection") {
      lines.push("### Reader reflection", "", "Book quote:", quote(entry.quote), "", "Reader's words:", body(entry.text), "", location, "");
    } else {
      lines.push("### Saved AI answer", "", "Book quote:", quote(entry.quote), "", "AI answer:", body(entry.savedAnswer!), "", location, "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
