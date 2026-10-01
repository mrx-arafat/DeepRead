// The longest title the edit form accepts, and what a file system accepts for one name (255 bytes, ".pdf" included).
const MAX_CHARS = 200;
const MAX_BYTES = 240;

/**
 * The file name the reader chose, as a title: "The_Problems_of_Philosophy.pdf" becomes "The Problems of Philosophy".
 * It also names the temporary upload, so it is safe to use as a file name and the parser, which names an untitled
 * book after the file it reads, ends up with it.
 */
export function titleFromFileName(fileName: string): string {
  let name = (fileName.split(/[\\/]/).pop() ?? "")
    .normalize("NFC")
    .replace(/\.pdf$/i, "")
    .replace(/\p{Cc}/gu, "")
    .replace(/_+/g, " ");
  // "problems-of-philosophy" has hyphens instead of spaces; "Russell - Problems" uses its hyphen as punctuation.
  if (!/\s/.test(name.trim())) name = name.replace(/-+/g, " ");
  name = name.replace(/\s+/g, " ").trim();

  let title = "";
  let chars = 0;
  for (const letter of name) {
    chars += letter.length;
    if (chars > MAX_CHARS || Buffer.byteLength(title + letter) > MAX_BYTES) break;
    title += letter;
  }
  return title.trim() || "Untitled book";
}
