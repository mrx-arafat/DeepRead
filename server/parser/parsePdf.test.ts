import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ParsedBook } from "../../shared/types.ts";
import { parsePdf } from "./parsePdf.mjs";
import type { ParseOptions } from "./parsePdf.mjs";

// The public-domain test book the reader-journey tests read: a Project Gutenberg PDF made from HTML.
const fixture = fileURLToPath(new URL("../../e2e/fixtures/problems-of-philosophy.pdf", import.meta.url));

describe("parsePdf on The Problems of Philosophy", () => {
  let book: ParsedBook;
  beforeAll(async () => {
    book = await parsePdf(fixture);
  }, 60_000);

  it("should give every line of the contents page its own entry, without the stray dot of an empty number column", () => {
    const front = book.chapters[0]!;
    const blocks = front.blocks.map((block) => block.text);
    const rows = blocks.slice(blocks.indexOf("Contents") + 1);
    // As printed on pages 1 and 2 of the PDF, the number column and the title joined by a space.
    expect(rows).toEqual([
      "PREFACE",
      "CHAPTER I. APPEARANCE AND REALITY",
      "CHAPTER II. THE EXISTENCE OF MATTER",
      "CHAPTER III. THE NATURE OF MATTER",
      "CHAPTER IV. IDEALISM",
      "CHAPTER V. KNOWLEDGE BY ACQUAINTANCE AND KNOWLEDGE BY DESCRIPTION",
      "CHAPTER VI. ON INDUCTION",
      "CHAPTER VII. ON OUR KNOWLEDGE OF GENERAL PRINCIPLES",
      "CHAPTER VIII. HOW A PRIORI KNOWLEDGE IS POSSIBLE",
      "CHAPTER IX. THE WORLD OF UNIVERSALS",
      "CHAPTER X. ON OUR KNOWLEDGE OF UNIVERSALS",
      "CHAPTER XI. ON INTUITIVE KNOWLEDGE",
      "CHAPTER XII. TRUTH AND FALSEHOOD",
      "CHAPTER XIII. KNOWLEDGE, ERROR, AND PROBABLE OPINION",
      "CHAPTER XIV. THE LIMITS OF PHILOSOPHICAL KNOWLEDGE",
      "CHAPTER XV. THE VALUE OF PHILOSOPHY",
      "BIBLIOGRAPHICAL NOTE",
    ]);
    expect(front.blocks.slice(-rows.length).every((block) => block.type === "paragraph")).toBe(true);
  });
});

// Small real PDFs exercise pdf.js item geometry as well as the layout heuristics.
function layoutPdf(content: string, garbled = false): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R /F5 9 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${garbled ? "/ToUnicode 10 0 R" : ""} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
  ];
  if (garbled) {
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Broken def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 95 beginbfchar\n${Array.from({ length: 95 }, (_, i) => `<${(32 + i).toString(16).padStart(2, "0")}> <${(0xe000 + i).toString(16)}>`).join("\n")}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
    objects.push(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, at) => {
    offsets.push(pdf.length);
    pdf += `${at + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function draw(text: string, x: number, y: number, font = "F1", size = 12): string {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  return `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escaped}) Tj ET`;
}

describe("parsePdf layout fidelity", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "deepread-layout-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  const parse = async (name: string, content: string, options: ParseOptions = {}) => {
    const path = join(dir, `${name}.pdf`);
    await writeFile(path, layoutPdf(content));
    const book = await parsePdf(path, options);
    return { book, blocks: book.chapters.flatMap((c) => c.blocks) };
  };

  it("keeps every unpunctuated list item separate and attaches hanging continuation lines", async () => {
    const { blocks } = await parse("lists", [
      draw("1. First item with enough words", 60, 700),
      draw("continued on this indented line", 75, 684),
      draw("2. Second item without punctuation", 60, 668),
      draw("3. Third item without punctuation", 60, 652),
    ].join("\n"));
    expect(blocks.map((b) => b.text)).toEqual([
      "1. First item with enough words continued on this indented line",
      "2. Second item without punctuation",
      "3. Third item without punctuation",
    ]);
    expect(blocks.every((b) => b.type === "paragraph" && b.format === "list-item")).toBe(true);
  });

  it("preserves monospace newlines, indentation, spaces, and literal markdown", async () => {
    const { blocks } = await parse("code", [
      draw("function greet(name) {", 60, 700, "F2"),
      draw('return "hello  " + name;', 74.4, 684, "F2"),
      draw("}", 60, 668, "F2"),
      draw("The text **stays literal** and <tags> remain readable.", 60, 628),
    ].join("\n"));
    expect(blocks[0]).toMatchObject({ type: "code", text: 'function greet(name) {\n  return "hello  " + name;\n}' });
    expect(blocks.at(-1)?.text).toBe("The text **stays literal** and <tags> remain readable.");
  });

  it("keeps a code listing separate after an unpunctuated list item", async () => {
    const { blocks } = await parse("list-before-code", [
      draw("1. First printed list item stays separate", 60, 720),
      draw("2. Second printed list item stays separate", 60, 704),
      draw("function sample() {", 60, 664, "F2"),
      draw("return 42;", 74.4, 648, "F2"),
      draw("}", 60, 632, "F2"),
    ].join("\n"));
    expect(blocks.map((b) => [b.type, b.text])).toEqual([
      ["paragraph", "1. First printed list item stays separate"],
      ["paragraph", "2. Second printed list item stays separate"],
      ["code", "function sample() {\n  return 42;\n}"],
    ]);
  });

  it("continues a sentence through a nearby monospace URL or identifier", async () => {
    for (const token of ["book.chapter", "https://example.com/page?mode=read"]) {
      const { blocks } = await parse("inline-mono", [
        draw("This sentence refers to the identifier", 60, 700),
        draw(token, 60, 684, "F2"),
        draw("which is explained here in more detail.", 60, 668),
      ].join("\n"));
      expect(blocks.map((b) => b.text)).toEqual([
        `This sentence refers to the identifier ${token} which is explained here in more detail.`,
      ]);
    }
  });

  it("preserves inline bold/italic offsets, source font families, size ratios, and centered captions", async () => {
    const { blocks } = await parse("typography", [
      draw("This line has", 60, 730),
      draw("bold words", 140, 730, "F3"),
      draw("and", 220, 730),
      draw("italic words.", 255, 730, "F4"),
      draw("Serif prose keeps its original family.", 60, 690, "F5"),
      draw("Centered Heading", 230, 650, "F3", 18),
      "0.2 0.4 0.7 rg 220 530 172 70 re f 0 0 0 rg",
      draw("Figure 1.", 282, 514, "F4"),
      draw("Synthetic bold overprint.", 60, 470),
      draw("Synthetic bold overprint.", 60.2, 470),
    ].join("\n"), { ocr: false });
    const prose = blocks[0]!;
    expect(prose.text).toBe("This line has bold words and italic words.");
    const bold = prose.runs?.find((run) => run.bold)!;
    const italic = prose.runs?.find((run) => run.italic)!;
    expect(prose.text.slice(bold.start, bold.end)).toBe("bold words");
    expect(prose.text.slice(italic.start, italic.end)).toBe("italic words.");
    expect(prose.style).toMatchObject({ fontFamily: "sans-serif", fontSize: 1, align: "left" });
    expect(blocks.find((b) => b.text.startsWith("Serif prose"))?.style?.fontFamily).toBe("serif");
    expect(blocks.find((b) => b.text === "Centered Heading")?.style).toMatchObject({ bold: true, align: "center", fontSize: 1.5 });
    expect(blocks.find((b) => b.text === "Figure 1.")).toMatchObject({ format: "caption", style: { italic: true, align: "center" } });
    expect(blocks.find((b) => b.text === "Synthetic bold overprint.")?.style?.bold).toBe(true);
  });

  it("keeps a centered italic caption separate from closely following body text", async () => {
    const { blocks } = await parse("caption-boundary", [
      draw("The paragraph before the illustration is ordinary body text.", 60, 730),
      "0.15 0.4 0.7 rg 80 440 360 180 re f 0 0 0 rg",
      draw("Figure 1. A blue illustration", 230, 425, "F4"),
      draw("This paragraph appears after the illustration in the book.", 60, 410),
    ].join("\n"), { ocr: false });
    const caption = blocks.find((b) => b.format === "caption")!;
    expect(caption.text).toBe("Figure 1. A blue illustration");
    expect(caption.style?.italic).toBe(true);
    const body = blocks.find((b) => b.text.startsWith("This paragraph"))!;
    expect(body.type).toBe("paragraph");
    expect(body.format).toBeUndefined();
    expect(body.style?.italic).not.toBe(true);
    expect(body.style?.align).toBe("left");
  });

  it("keeps wrapped caption lines together until font and alignment change", async () => {
    const { blocks } = await parse("wrapped-caption", [
      draw("Ordinary body text before the illustrated figure remains readable.", 60, 730),
      "0.15 0.4 0.7 rg 80 440 360 180 re f 0 0 0 rg",
      draw("Figure 1. A centered caption", 225, 425, "F4"),
      draw("Continues on another line", 244, 410, "F4"),
      draw("The next paragraph uses the normal book typeface.", 60, 395),
    ].join("\n"), { ocr: false });
    const caption = blocks.find((b) => b.format === "caption")!;
    expect(caption.text).toBe("Figure 1. A centered caption Continues on another line");
    expect(caption.style?.italic).toBe(true);
    expect(blocks.find((b) => b.text.startsWith("The next paragraph"))?.format).toBeUndefined();
  });

  it("keeps inline style offsets correct after line-end dehyphenation", async () => {
    const { blocks } = await parse("styled-dehyphenation", [
      draw("A source word is extraordi-", 60, 700),
      draw("nary and important for the reader.", 60, 684, "F3"),
    ].join("\n"));
    const block = blocks[0]!;
    expect(block.text).toBe("A source word is extraordinary and important for the reader.");
    const bold = block.runs?.find((run) => run.bold)!;
    expect(block.text.slice(bold.start, bold.end)).toBe("nary and important for the reader.");
    expect(block.runs?.every((run) => run.start >= 0 && run.end <= block.text.length && run.start < run.end)).toBe(true);
  });

  it("reads repeated prose columns down the left before the right, preserving all text", async () => {
    const left = [
      "Left first line tells the story",
      "and continues on its own side",
      "while keeping every printed word",
      "until the final left sentence.",
    ];
    const right = [
      "Right first line starts afterwards",
      "and stays in this second column",
      "with the rest of this passage",
      "until the final right sentence.",
    ];
    const { blocks, book } = await parse("columns", left.flatMap((text, i) => [draw(text, 50, 700 - i * 16), draw(right[i]!, 330, 700 - i * 16)]).join("\n"));
    expect(blocks.map((b) => b.text).join(" ")).toBe([...left, ...right].join(" "));
    expect(book.warnings.some((warning) => warning.includes("Text coverage check"))).toBe(false);
  });

  it("retains a figure between its surrounding paragraphs and keeps native labels selectable", async () => {
    const { blocks } = await parse("figure-placement", [
      draw("This sentence continues before the printed illustration", 60, 700),
      "0.2 0.4 0.7 rg 60 663 190 27 re f 0 0 0 rg",
      draw("and continues after the illustration without being joined.", 60, 650),
    ].join("\n"), { ocr: false });
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "image", "paragraph"]);
    expect(blocks[0]?.text).toBe("This sentence continues before the printed illustration");
    expect(blocks[1]).toMatchObject({ text: "", image: { src: expect.stringMatching(/^data:image\/png;base64,/), width: 285, height: expect.any(Number) } });
    expect(blocks[2]?.text).toBe("and continues after the illustration without being joined.");
    const without = await parse("figure-opt-out", [
      draw("An ordinary paragraph remains readable with figures disabled.", 60, 700),
      "0.2 0.4 0.7 rg 60 610 190 70 re f",
    ].join("\n"), { images: false, ocr: false });
    expect(without.blocks.every((b) => b.type !== "image")).toBe(true);
  });

  it("retains accurate numeric native text without forcing OCR", async () => {
    const row = "1234567890 2345678901 3456789012 4567890123";
    const { book, blocks } = await parse("numeric-native", [draw(row, 60, 700), draw(row, 60, 684)].join("\n"));
    expect(blocks.map((b) => b.text).join(" ")).toBe(`${row} ${row}`);
    expect(book.warnings.some((warning) => warning.includes("Recovered text with local OCR"))).toBe(false);
    expect(blocks.some((b) => b.type === "image")).toBe(false);
  });

  it("does not mistake short table cells for prose columns", async () => {
    const { blocks } = await parse("short-cells", [
      ["Name", "Scores"], ["Alpha", "Ten"], ["Beta", "Twenty"], ["Gamma", "Thirty"], ["Delta", "Forty"],
    ].flatMap(([left, right], i) => [draw(left!, 60, 700 - i * 16), draw(right!, 330, 700 - i * 16)]).join("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "table", rows: [["Name", "Scores"], ["Alpha", "Ten"], ["Beta", "Twenty"], ["Gamma", "Thirty"], ["Delta", "Forty"]] });
    expect(blocks[0]?.text).toBe("Name\tScores\nAlpha\tTen\nBeta\tTwenty\nGamma\tThirty\nDelta\tForty");
  });
});


/** An actual raster-only PDF: OCR cannot accidentally pass by using a hidden text layer. */
function scannedPdf(illustrated = false, mixedNativeLabel = false): Buffer {
  const canvas = createCanvas(1000, 500);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  context.font = "30px sans-serif";
  [
    "The scanned page has readable words inside an image.",
    "Local recognition restores this sentence for the reader.",
    "The original page remains available to check the text.",
    "Every paragraph should remain searchable and selectable.",
  ].forEach((text, i) => context.fillText(text, 45, 90 + i * 75));
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgb = Buffer.alloc(canvas.width * canvas.height * 3);
  for (let p = 0, i = 0; p < pixels.length; p += 4) {
    rgb[i++] = pixels[p]!;
    rgb[i++] = pixels[p + 1]!;
    rgb[i++] = pixels[p + 2]!;
  }
  const compressed = deflateSync(rgb);
  const content = [illustrated ? draw("This native paragraph comes before an embedded figure.", 60, 750) : "", "q 550 0 0 275 30 430 cm /Scan Do Q", mixedNativeLabel ? draw("Readable chart title", 60, 695) : "", illustrated ? draw("The native paragraph after the picture remains readable.", 60, 390) : ""].join("\n");
  const objects: Array<string | Buffer> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Scan 5 0 R >> ${illustrated ? "/Font << /F1 6 0 R >>" : ""} >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from("\nendstream")]),
  ];
  if (illustrated) objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((object, at) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${at + 1} 0 obj\n`), typeof object === "string" ? Buffer.from(object) : object, Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    length += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

const hasTesseract = spawnSync("tesseract", ["--version"], { timeout: 2000, stdio: "ignore" }).status === 0;

it.skipIf(!hasTesseract)("recovers actual scanned image text with local OCR and retains its original page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deepread-scan-"));
  try {
    const path = join(dir, "scan.pdf");
    await writeFile(path, scannedPdf());
    const book = await parsePdf(path, { pageTimeoutMs: 20_000 });
    const blocks = book.chapters.flatMap((c) => c.blocks);
    const text = blocks.filter((b) => b.type !== "image").map((b) => b.text).join(" ");
    expect(text).toContain("The scanned page has readable words inside an image.");
    expect(text).toContain("Every paragraph should remain searchable and selectable.");
    expect(blocks.at(-1)).toMatchObject({ type: "image", text: "", image: { alt: "Original scanned page 1" } });
    expect(book.warnings.some((w) => w.includes("Recovered text with local OCR"))).toBe(true);
    expect(book.warnings.some((w) => w.includes("content is missing"))).toBe(false);
    await expect(parsePdf(path, { ocr: false })).rejects.toMatchObject({ code: "scanned", message: expect.stringContaining("Install Tesseract") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);


it.skipIf(!hasTesseract)("recovers visible text when the PDF font character map is garbled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deepread-garbled-"));
  try {
    const path = join(dir, "garbled.pdf");
    const content = [
      draw("This visible paragraph uses a broken character map.", 60, 700, "F1", 18),
      draw("Local recognition recovers the words from the page.", 60, 674, "F1", 18),
      draw("The original picture stays available for comparison.", 60, 648, "F1", 18),
    ].join("\n");
    await writeFile(path, layoutPdf(content, true));
    const book = await parsePdf(path, { pageTimeoutMs: 20_000 });
    const text = book.chapters.flatMap((c) => c.blocks).map((b) => b.text).join(" ");
    expect(text).toContain("This visible paragraph uses a broken character map.");
    expect(text).toContain("Local recognition recovers the words from the page.");
    expect(book.warnings.some((w) => w.includes("Recovered text with local OCR"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);


it.skipIf(!hasTesseract)("makes embedded image text selectable beside its figure in an illustrated PDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deepread-illustrated-"));
  try {
    const path = join(dir, "illustrated.pdf");
    await writeFile(path, scannedPdf(true));
    const book = await parsePdf(path, { pageTimeoutMs: 20_000 });
    const blocks = book.chapters.flatMap((c) => c.blocks);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "image", "paragraph", "paragraph"]);
    expect(blocks[1]?.image?.ocrText).toContain("The scanned page has readable words inside an image.");
    expect(blocks[2]).toMatchObject({ format: "figure-text", text: expect.stringContaining("Every paragraph should remain searchable and selectable.") });
    expect(blocks[3]?.text).toBe("The native paragraph after the picture remains readable.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);


it.skipIf(!hasTesseract)("retains raster figure labels when its chart title also has native PDF text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deepread-mixed-figure-"));
  try {
    const path = join(dir, "mixed-figure.pdf");
    await writeFile(path, scannedPdf(true, true));
    const book = await parsePdf(path, { pageTimeoutMs: 20_000 });
    const blocks = book.chapters.flatMap((c) => c.blocks);
    expect(blocks.find((b) => b.format === "figure-text")?.text).toContain("Every paragraph should remain searchable and selectable.");
    expect(blocks.some((b) => b.type === "paragraph" && b.text === "Readable chart title")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
