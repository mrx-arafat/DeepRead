// Deterministic "big PDF" fixtures for reader performance work: long pseudo-prose books with or without an outline,
// and a heavily illustrated one. Hand-written PDF (like illustrated-book.mjs), figures drawn with @napi-rs/canvas.
//   import { bigBookPdf } from "./big-book.mjs";  bigBookPdf("text-outline") -> Buffer
//   node e2e/fixtures/big-book.mjs <text-outline|text-plain|text-parts|illustrated> <out.pdf> [--pages N] [--seed N]
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PAGE = { width: 612, height: 792, margin: 72 };
const BODY = { font: "F1", size: 12, leading: 18, chars: 76 };
const HEADING = { font: "F2", size: 20 };
const CAPTION = { font: "F3", size: 10 };
const FIGURE = { width: 468, height: 351, pixels: [1600, 1200] };

export const VARIANTS = {
  "text-outline": { pages: 1400, chapters: 36, outline: "chapters", headings: true, figures: 0 },
  "text-plain": { pages: 1400, chapters: 36, outline: "none", headings: false, figures: 0 },
  "text-parts": { pages: 1400, chapters: 3, outline: "chapters", headings: true, figures: 0, partTitles: true },
  illustrated: { pages: 400, chapters: 36, outline: "chapters", headings: true, figures: 160 },
};

const WORDS = (
  "the of and to in that is was for with as on by at from this which have not are be or an one all their there been " +
  "has more when who will would each other into than its also time these two some could them see only new way may " +
  "first any over such our made after most where through before between under same while both still every long " +
  "reader page book chapter story river mountain village morning evening window garden letter bridge market harbour " +
  "teacher student lesson question answer number pattern figure table light shadow silence memory journey return " +
  "quiet simple careful honest patient curious steady gentle narrow distant early late open closed whole small large " +
  "walk read write listen build measure repair gather follow explain remember forget decide prepare arrive begin finish " +
  "slowly often rarely almost nearly perhaps rather quite really together apart inside outside beyond behind toward " +
  "field forest stone water cloud season harvest winter summer spring autumn road path door wall roof floor corner"
).split(/\s+/);

/** Small seeded PRNG so every run makes the same book. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(random, index) {
  const count = 8 + Math.floor(random() * 9);
  const words = [];
  for (let at = 0; at < count; at++) {
    let word = WORDS[Math.floor(random() * WORDS.length)];
    if (at === 0) word = word[0].toUpperCase() + word.slice(1);
    if (at > 2 && at < count - 1 && random() < 0.12) word += ",";
    words.push(word);
  }
  // A number in the text now and then keeps the prose varied without ever repeating a paragraph.
  if (random() < 0.3) words.splice(Math.min(words.length - 1, 3), 0, String(100 + ((index * 37) % 900)));
  return words.join(" ") + (random() < 0.08 ? "?" : ".");
}

function paragraph(random, index) {
  const count = 4 + Math.floor(random() * 4);
  return Array.from({ length: count }, (_, at) => sentence(random, index * 10 + at)).join(" ");
}

function wrap(text, chars) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > chars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const titleWords = ["Harbour", "Lessons", "Patterns", "Journey", "Return", "Silence", "Seasons", "Bridges", "Letters", "Gardens", "Measures", "Shadows"];
const chapterTitle = (random, number, part) =>
  part ? `Part ${["One", "Two", "Three", "Four", "Five", "Six"][number - 1] ?? number}` : `Chapter ${number}: ${titleWords[Math.floor(random() * titleWords.length)]} of the ${WORDS[60 + Math.floor(random() * 40)]}`;

const escapePdf = (text) => text.replace(/[\\()]/g, (match) => `\\${match}`).replace(/[^\x20-\x7e]/g, "?");
const draw = (text, x, y, font, size) => `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdf(text)}) Tj ET`;

/** One figure as a JPEG, distinct per number: flat shapes keep the parser's PNG crops small. */
function figureJpeg(number, random) {
  const require = createRequireOnce();
  const { createCanvas } = require("@napi-rs/canvas");
  const [width, height] = FIGURE.pixels;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const hue = Math.floor(random() * 360);
  ctx.fillStyle = `hsl(${hue} 35% 88%)`;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = `hsl(${(hue + 180) % 360} 45% 45%)`;
  ctx.fillRect(width * 0.08, height * 0.12, width * 0.84, height * 0.1);
  for (let at = 0; at < 6; at++) {
    ctx.fillStyle = `hsl(${(hue + at * 40) % 360} 50% ${40 + at * 6}%)`;
    const x = width * (0.1 + at * 0.14);
    const bar = height * (0.2 + random() * 0.5);
    ctx.fillRect(x, height * 0.88 - bar, width * 0.1, bar);
  }
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(width * 0.08, height * 0.88);
  ctx.lineTo(width * 0.92, height * 0.88);
  ctx.stroke();
  ctx.fillStyle = "#111";
  ctx.font = "bold 72px sans-serif";
  ctx.fillText(`Figure ${number}`, width * 0.1, height * 0.1);
  return canvas.toBuffer("image/jpeg", 80);
}

// The canvas binding is only loaded for the illustrated variant.
const createRequireOnce = () => createRequire(import.meta.url);

/**
 * Lays the book out page by page. Each page is { content: string[], image?: number } where image is a figure number.
 * Chapters start on a new page; the heading sits at the top when `headings` is on. Figures are spread evenly.
 */
function layout(spec, random) {
  const pages = [];
  const chapters = [];
  const figures = [];
  const perChapter = spec.pages / spec.chapters;
  let figureDue = spec.figures ? spec.pages / spec.figures : Infinity;
  let paragraphIndex = 0;
  let figureNumber = 0;
  const top = PAGE.height - PAGE.margin;
  const bottom = PAGE.margin;
  for (let chapter = 0; chapter < spec.chapters; chapter++) {
    const title = chapterTitle(random, chapter + 1, spec.partTitles);
    const chapterEnd = Math.round((chapter + 1) * perChapter);
    chapters.push({ title, page: pages.length + 1, top: top + HEADING.size });
    let heading = spec.headings;
    let pending = [];
    while (pages.length < chapterEnd) {
      const content = [];
      let y = top;
      const page = { content, number: pages.length + 1 };
      if (heading) {
        content.push(draw(title, PAGE.margin, y - HEADING.size + 4, HEADING.font, HEADING.size));
        y -= HEADING.size + 24;
        heading = false;
      }
      if (pages.length + 1 >= figureDue && figureNumber < spec.figures) {
        figureNumber++;
        figureDue += spec.pages / spec.figures;
        const figureTop = y - 6;
        const figureBottom = figureTop - FIGURE.height;
        content.push(`q ${FIGURE.width} 0 0 ${FIGURE.height} ${PAGE.margin} ${figureBottom} cm /Im${figureNumber} Do Q`);
        const captionY = figureBottom - 14;
        content.push(draw(`Figure ${figureNumber}. A ${WORDS[100 + (figureNumber % 60)]} measured across the ${WORDS[40 + (figureNumber % 30)]}.`, PAGE.margin, captionY, CAPTION.font, CAPTION.size));
        page.image = figureNumber;
        figures.push({ number: figureNumber, page: page.number });
        y = captionY - 30;
      }
      let first = true;
      while (y - BODY.leading >= bottom) {
        if (!pending.length) pending = wrap(paragraph(random, paragraphIndex++), BODY.chars);
        if (!first && pending.length === wrap(pending.join(" "), BODY.chars).length && content.at(-1)?.endsWith("Tj ET")) {
          // A whole paragraph starts here: a blank line before it, if it still fits.
          if (y - 2 * BODY.leading < bottom) break;
          y -= BODY.leading;
        }
        first = false;
        while (pending.length && y - BODY.leading >= bottom) {
          y -= BODY.leading;
          content.push(draw(pending.shift(), PAGE.margin, y, BODY.font, BODY.size));
        }
        if (pending.length) break;
      }
      pages.push(page);
    }
  }
  return { pages, chapters, figures };
}

/** The PDF bytes for `variant`; `options` override the variant's page/chapter/figure counts or seed. */
export function bigBookPdf(variant, options = {}) {
  const base = VARIANTS[variant];
  if (!base) throw new Error(`Unknown variant ${variant}; use ${Object.keys(VARIANTS).join(", ")}`);
  const spec = { ...base, ...options };
  const random = rng(spec.seed ?? 20261028);
  const { pages, chapters, figures } = layout(spec, random);

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const ref = (n) => `${n} 0 R`;
  const catalog = add(null);
  const pagesRoot = add(null);
  const info = add(`<< /Title (${escapePdf(spec.title ?? `Big Book ${variant}`)}) /Author (DeepRead Fixtures) >>`);
  const fonts = {
    F1: add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>"),
    F2: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    F3: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
  };
  const fontDict = `/Font << ${Object.entries(fonts).map(([name, n]) => `/${name} ${ref(n)}`).join(" ")} >>`;
  const images = new Map();
  for (const figure of figures) {
    const jpeg = figureJpeg(figure.number, random);
    images.set(figure.number, add([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${FIGURE.pixels[0]} /Height ${FIGURE.pixels[1]} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "latin1"), jpeg, Buffer.from("\nendstream", "latin1")]));
  }
  const pageIds = [];
  for (const page of pages) {
    const content = page.content.join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    const xobject = page.image ? ` /XObject << /Im${page.image} ${ref(images.get(page.image))} >>` : "";
    pageIds.push(add(`<< /Type /Page /Parent ${ref(pagesRoot)} /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Contents ${ref(stream)} /Resources << ${fontDict}${xobject} >> >>`));
  }
  objects[pagesRoot - 1] = `<< /Type /Pages /Kids [${pageIds.map(ref).join(" ")}] /Count ${pageIds.length} >>`;
  let outlines = null;
  if (spec.outline === "chapters") {
    outlines = add(null);
    const items = chapters.map(() => add(null));
    items.forEach((n, at) => {
      const chapter = chapters[at];
      const links = [`/Parent ${ref(outlines)}`];
      if (at > 0) links.push(`/Prev ${ref(items[at - 1])}`);
      if (at < items.length - 1) links.push(`/Next ${ref(items[at + 1])}`);
      objects[n - 1] = `<< /Title (${escapePdf(chapter.title)}) ${links.join(" ")} /Dest [${ref(pageIds[chapter.page - 1])} /XYZ 0 ${chapter.top} 0] >>`;
    });
    objects[outlines - 1] = `<< /Type /Outlines /First ${ref(items[0])} /Last ${ref(items.at(-1))} /Count ${items.length} >>`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${ref(pagesRoot)}${outlines ? ` /Outlines ${ref(outlines)} /PageMode /UseOutlines` : ""} >>`;

  const chunks = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, at) => {
    offsets.push(offset);
    const parts = [Buffer.from(`${at + 1} 0 obj\n`, "latin1"), ...(Array.isArray(body) ? body : [Buffer.from(body, "latin1")]), Buffer.from("\nendobj\n", "latin1")];
    for (const part of parts) {
      chunks.push(part);
      offset += part.length;
    }
  });
  const xref = offset;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root ${ref(catalog)} /Info ${ref(info)} >>\nstartxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [variant, out, ...flags] = process.argv.slice(2);
  if (!variant || !out || !VARIANTS[variant]) {
    console.error(`usage: node e2e/fixtures/big-book.mjs <${Object.keys(VARIANTS).join("|")}> <out.pdf> [--pages N] [--chapters N] [--figures N] [--seed N]`);
    process.exit(2);
  }
  const options = {};
  for (let at = 0; at < flags.length; at += 2) options[flags[at].replace(/^--/, "")] = Number(flags[at + 1]);
  const started = Date.now();
  const pdf = bigBookPdf(variant, options);
  await writeFile(out, pdf);
  console.log(`variant: ${variant}\nfile: ${out}\nbytes: ${pdf.length}\nms: ${Date.now() - started}`);
}
