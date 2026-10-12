#!/usr/bin/env node
// DeepRead PDF -> Book parser (prototype).
//
// Pure Node: pdfjs-dist text extraction + layout heuristics.
//   parsePdf(filePath, opts?)          -> Promise<Book>   (in-process, every pdf.js await is time-guarded)
//   parsePdfIsolated(filePath, opts?)  -> Promise<Book>   (runs parsePdf in a worker thread with a hard kill)
//   CLI: node parsePdf.mjs <file.pdf> [--isolated] [--no-outline] [--compact]  -> Book JSON on stdout
//        on failure prints {"error": code, "message": ...} on stdout and exits 2.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";
import { createRequire } from "node:module";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { separateMatter } from "./matter.mjs";
import { extractPageVisuals } from "./pdfVisuals.mjs";

/**
 * @typedef {import("../../shared/types.ts").Block} Block
 * @typedef {{ id: string, title: string, kind: "front" | "body" | "back", startPage: number, endPage: number, blocks: Block[] }} Chapter
 * @typedef {{ title: string, author: string | null, pageCount: number, chapters: Chapter[], warnings: string[] }} Book
 * @typedef {"not_found" | "invalid_pdf" | "encrypted" | "scanned" | "garbled" | "empty" | "timeout"} ParseErrorCode
 * @typedef {{
 *   useOutline?: boolean,        // default true; false forces heading/page-range fallback (testing)
 *   openTimeoutMs?: number,      // getDocument()
 *   stepTimeoutMs?: number,      // getOutline/getMetadata/getDestination/getPageIndex
 *   pageTimeoutMs?: number,      // getPage + getTextContent, per page
 *   totalTimeoutMs?: number,     // whole parse budget
 *   images?: boolean,           // default true: preserve PDF figures
 *   ocr?: boolean,              // default true: local Tesseract OCR when needed
 *   ocrLanguage?: string,       // default DEEPREAD_OCR_LANG or eng
 *   ocrTimeoutMs?: number,      // each local OCR call, also bounded by page/total budgets
 *   hardTimeoutMs?: number,      // parsePdfIsolated only: worker is terminated after this
 * }} ParseOptions
 */

const DEFAULTS = {
  useOutline: true,
  images: true,
  ocr: true,
  ocrTimeoutMs: 15_000,
  openTimeoutMs: 30_000,
  stepTimeoutMs: 10_000,
  pageTimeoutMs: 10_000,
  totalTimeoutMs: 240_000,
  hardTimeoutMs: 300_000,
};

export class PdfParseError extends Error {
  /** @param {ParseErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "PdfParseError";
    this.code = code;
  }
  toJSON() {
    return { error: this.code, message: this.message };
  }
}

class StepTimeout extends Error {
  constructor(label, ms) {
    super(`${label} did not finish within ${ms} ms`);
    this.label = label;
  }
}

/** Race a promise against a timer. The pending timer also keeps the event loop alive, so a stalled
 *  pdf.js promise can never make the process exit silently mid-parse. */
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(label, ms)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------------
// Text utilities

const LIGATURES = { "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi", "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st" };

/** Raw item string -> safe string (keeps U+00AD so line-end soft hyphens can be honoured). */
function cleanStr(s) {
  return s
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c])
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF\uFFFE\uFFFF]/g, "")
    .replace(/[\t\n\v\f\r\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

/** Final text normalisation for anything that leaves the parser. */
function finalText(s) {
  return cleanStr(s).replace(/\u00AD/g, "").replace(/\s+/g, " ").trim();
}

/** Loose comparison key: letters and digits only. */
function normKey(s) {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const TERMINAL_RE = /[.!?\u2026:;]["'\u201D\u2019\u00BB)\]]*$/;
const BULLET_RE = /^(?:[\u2022\u25CF\u25CB\u25E6\u25AA\u25A0\u25A1\u2023\u2219\u27A2\u27A4\u2713\u2714*+-]\s|\(?\d{1,2}[.)]\s|\d{1,2}(?:\.\d{1,2})+\s|\(?[a-z][.)]\s)/;
// a list marker sitting alone on its line ("3.", "a)", a bullet), with the item text below it
const BARE_MARKER_RE = /^(?:\(?\d{1,3}[.)]|[a-z][.)]|[\u2022\u25CF\u25A0\u25AA*-])$/;
const CHAPTER_RE =
  /^(?:chapter|chap\.)\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;
const PART_RE = /^(?:part|book|volume)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

// section titles that open front/back matter, recognised when they share the chapter headings' style
const MATTER_RE =
  /^(?:preface|foreword|introduction|prologue|epilogue|afterword|postscript|conclusion|appendix\b.*|notes|endnotes|bibliograph.*|references|further reading|glossary|index|acknowledge?ments|about the authors?)$/i;

/** Letters and digits in a string: the unit of the text-coverage self-check. */
const alnum = (str) => (str.match(/[\p{L}\p{N}]/gu) ?? []).length;

const mode = (values) => {
  const m = new Map();
  let best = null;
  let bestN = 0;
  for (const v of values) {
    const n = (m.get(v) ?? 0) + 1;
    m.set(v, n);
    if (n > bestN) [best, bestN] = [v, n];
  }
  return best;
};
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Letters and numbers are both readable text; private-use/replacement glyphs signal a broken map. */
function textQuality(text) {
  const visible = text.replace(/\s/g, "").length;
  const legible = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const junk = (text.match(/[\uE000-\uF8FF\uFFFD]/g) ?? []).length;
  return { garbled: visible > 0 && (legible / visible < 0.5 || junk / visible > 0.1) };
}

// ---------------------------------------------------------------------------------------------
// Stage 1: extraction (the only part that talks to pdf.js; everything after is pure functions)

let pdfjsModule;
async function loadPdfjs() {
  pdfjsModule ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsModule;
}

async function extract(filePath, o, warnings) {
  const { getDocument } = await loadPdfjs();
  let data;
  try {
    data = new Uint8Array(await readFile(filePath));
  } catch (e) {
    throw new PdfParseError("not_found", `Cannot read file: ${e.message}`);
  }
  const deadline = Date.now() + o.totalTimeoutMs;
  const assets = `${dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))}/`;
  const task = getDocument({
    data,
    standardFontDataUrl: `${assets}standard_fonts/`,
    cMapUrl: `${assets}cmaps/`,
    wasmUrl: `${assets}wasm/`,
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  try {
    let doc;
    try {
      doc = await withTimeout(task.promise, o.openTimeoutMs, "Opening the PDF");
    } catch (e) {
      if (e?.name === "PasswordException") throw new PdfParseError("encrypted", "This PDF is password-protected.");
      if (e instanceof StepTimeout) throw new PdfParseError("timeout", e.message);
      throw new PdfParseError("invalid_pdf", `Not a readable PDF: ${e?.message ?? e}`);
    }

    let info = null;
    try {
      info = (await withTimeout(doc.getMetadata(), o.stepTimeoutMs, "Reading metadata"))?.info ?? null;
    } catch (e) {
      warnings.push(`Metadata unavailable (${e.message}).`);
    }

    let outline = [];
    if (o.useOutline) {
      try {
        outline = await withTimeout(readOutline(doc, o), o.stepTimeoutMs * 3, "Reading the outline");
      } catch (e) {
        warnings.push(`Outline could not be read (${e.message}); chapters detected from text instead.`);
        outline = [];
      }
    }

    const pages = [];
    let failures = 0;
    let figureBytes = 0;
    let figureCount = 0;
    let ocrPages = 0;
    const visualWarnings = new Map();
    const warnVisual = (message) => visualWarnings.set(message, (visualWarnings.get(message) ?? 0) + 1);
    for (let p = 1; p <= doc.numPages; p++) {
      if (Date.now() > deadline) {
        throw new PdfParseError("timeout", `Parsing exceeded ${o.totalTimeoutMs} ms at page ${p} of ${doc.numPages}.`);
      }
      try {
        const page = await withTimeout(doc.getPage(p), o.pageTimeoutMs, `Loading page ${p}`);
        const tc = await withTimeout(page.getTextContent(), o.pageTimeoutMs, `Reading text of page ${p}`);
        let rawAlnum = tc.items.reduce((n, it) => n + (typeof it.str === "string" ? alnum(cleanStr(it.str)) : 0), 0);
        let items = compactItems(tc, page.view);
        const originalText = items.map((it) => it.s).join("");
        const garbled = textQuality(originalText).garbled;
        const scanned = originalText.replace(/\s/g, "").length < 40 || garbled;
        const figures = [];
        if (o.images || (o.ocr && scanned)) {
          const budget = Math.max(1, Math.min(o.pageTimeoutMs, deadline - Date.now()));
          try {
            const visuals = await withTimeout(extractPageVisuals(page, {
              pageNumber: p, textItems: items, scanned, forceOcr: garbled,
              images: o.images, ocr: o.ocr,
              ocrLanguage: o.ocrLanguage ?? process.env.DEEPREAD_OCR_LANG ?? "eng",
              timeoutMs: budget, totalBudgetMs: budget,
              ocrTimeoutMs: Math.min(o.ocrTimeoutMs, budget),
              maxFigures: Math.max(0, Math.min(12, 256 - figureCount)),
            }), budget + 100, `Reading figures and OCR on page ${p}`);
            for (const message of visuals.warnings) warnVisual(message);
            if (visuals.ocrUsed && visuals.ocrItems.length) {
              const recovered = visuals.ocrItems.map((it) => it.s).join(" ");
              if (!textQuality(recovered).garbled && alnum(recovered) >= 40) {
                items = visuals.ocrItems;
                rawAlnum = alnum(recovered);
                ocrPages++;
              }
            }
            for (const figure of visuals.figures) {
              const bytes = Math.ceil(figure.image.src.length * 0.75);
              if (figureCount >= 256 || figureBytes + bytes > 64 * 1024 * 1024) {
                warnVisual("Some figures were omitted because the book reached its figure storage limit.");
                break;
              }
              figures.push(figure);
              figureBytes += bytes;
              figureCount++;
            }
          } catch (e) {
            warnVisual(`Some page figures or OCR could not be read (${e.message}).`);
          }
        }
        try {
          await withTimeout(page.getOperatorList(), Math.max(1, Math.min(o.pageTimeoutMs, deadline - Date.now())), `Reading font styles on page ${p}`);
          for (const item of items) {
            let font;
            try { if (item.fontName && page.commonObjs.has(item.fontName)) font = page.commonObjs.get(item.fontName); } catch { /* an unresolved font keeps its fallback */ }
            const name = font?.name ?? "";
            const family = font?.fallbackName ?? item.fontFamily ?? (item.mono ? "monospace" : "sans-serif");
            item.style = {
              fontFamily: /mono/i.test(family) ? "monospace" : /sans/i.test(family) ? "sans-serif" : "serif",
              bold: !!font?.bold || /bold|black|heavy|demi|semibold/i.test(name),
              italic: !!font?.italic || /italic|oblique/i.test(name),
            };
          }
        } catch { /* typography is optional; preserve readable text on a font-resolution failure */ }
        pages.push({ num: p, view: page.view, items, figures, rawAlnum, droppedAlnum: 0, hfAlnum: 0 });
        page.cleanup();
      } catch (e) {
        failures++;
        pages.push({ num: p, view: [0, 0, 612, 792], items: [], failed: true, rawAlnum: 0, droppedAlnum: 0, hfAlnum: 0 });
        if (failures > Math.max(10, doc.numPages * 0.2)) {
          throw new PdfParseError("timeout", `Too many pages failed to load (last: ${e.message}).`);
        }
      }
    }
    if (failures) warnings.push(`${failures} page(s) could not be read and were skipped.`);
    if (ocrPages) warnings.push(`Recovered text with local OCR on ${ocrPages} page(s); recognition may contain mistakes. The original page is retained when figures are enabled.`);
    let warningCount = 0;
    for (const [message, count] of visualWarnings) {
      if (warningCount++ < 20) warnings.push(count > 1 ? `${message} (${count} pages or figures)` : message);
    }
    if (visualWarnings.size > 20) warnings.push(`${visualWarnings.size - 20} additional figure/OCR warnings were omitted.`);
    return { numPages: doc.numPages, info, outline, pages };
  } finally {
    // destroy() terminates the (fake) worker; guard it too so cleanup can never hang the caller.
    await withTimeout(task.destroy(), 5_000, "Closing the PDF").catch(() => {});
  }
}

/** Flatten the outline and resolve every destination to a 1-based page + y. */
async function readOutline(doc, o) {
  const raw = (await withTimeout(doc.getOutline(), o.stepTimeoutMs, "getOutline")) ?? [];
  const refCache = new Map();
  const out = [];
  const resolveDest = async (dest) => {
    if (typeof dest === "string") dest = await withTimeout(doc.getDestination(dest), o.stepTimeoutMs, "getDestination");
    if (!Array.isArray(dest) || dest.length === 0) return { page: null, top: null };
    const ref = dest[0];
    let index = null;
    if (typeof ref === "number") index = ref;
    else if (ref && typeof ref === "object") {
      const key = `${ref.num}R${ref.gen}`;
      if (!refCache.has(key)) {
        refCache.set(key, await withTimeout(doc.getPageIndex(ref), o.stepTimeoutMs, "getPageIndex").catch(() => null));
      }
      index = refCache.get(key);
    }
    const kind = dest[1]?.name;
    let top = null;
    if (kind === "XYZ") top = dest[3];
    else if (kind === "FitH" || kind === "FitBH") top = dest[2];
    else if (kind === "FitR") top = dest[5];
    return {
      page: Number.isInteger(index) && index >= 0 && index < doc.numPages ? index + 1 : null,
      top: typeof top === "number" && Number.isFinite(top) ? top : null,
    };
  };
  const walk = async (items, depth, parent) => {
    for (const it of items ?? []) {
      const title = finalText(String(it.title ?? ""));
      let target = { page: null, top: null };
      try {
        target = await resolveDest(it.dest);
      } catch {
        /* unresolvable destination: keep the title, locate it by text later */
      }
      const entry = { title, depth, page: target.page, top: target.top, parent, children: [] };
      if (title) {
        out.push(entry);
        parent?.children.push(entry);
      }
      await walk(it.items, depth + 1, title ? entry : parent);
    }
  };
  await walk(raw, 0, null);
  return out;
}

/** Keep only what layout analysis needs; drop rotated/vertical/off-page text. */
function compactItems(tc, view) {
  const out = [];
  for (const it of tc.items) {
    if (typeof it.str !== "string" || it.str.length === 0) continue;
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d);
    if (!(size > 0.5)) continue;
    if (a <= 0 || d <= 0 || Math.abs(b) > 0.05 * a || Math.abs(c) > 0.05 * d) continue; // rotated text
    if (e < view[0] - 5 || e > view[2] + 5 || f < view[1] - 5 || f > view[3] + 5) continue; // off-page
    const s = cleanStr(it.str);
    // whitespace-only items are explicit word breaks (pdf.js emits them even when the geometric gap is tiny)
    if (!s.trim()) out.push({ s: " ", ws: true, x: e, y: f, w: Math.max(0, it.width), size });
    else out.push({ s, x: e, y: f, w: Math.max(0, it.width), size, mono: tc.styles?.[it.fontName]?.fontFamily === "monospace", fontName: it.fontName, fontFamily: tc.styles?.[it.fontName]?.fontFamily });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stage 2: items -> lines

function buildLines(page) {
  const { items, view } = page;
  const textItems = items.filter((it) => !it.ws);
  if (!textItems.length) return [];
  const pageSize = median(textItems.flatMap((it) => Array(Math.min(50, it.s.length)).fill(it.size)));

  const dropCaps = [];
  const normal = [];
  for (const it of items) {
    if (!it.ws && /^["\u201C\u2018']?\p{Lu}$/u.test(it.s.trim()) && it.size >= 1.8 * pageSize) dropCaps.push(it);
    else normal.push(it);
  }

  normal.sort((p, q) => q.y - p.y || p.x - q.x);
  const groups = [];
  let cur = null;
  for (const it of normal) {
    if (cur && cur.refY - it.y <= 0.5 * Math.min(cur.refSize, it.size)) cur.items.push(it);
    else {
      cur = { refY: it.y, refSize: it.size, items: [it] };
      groups.push(cur);
    }
  }

  const columnGroups = splitProseColumns(groups, view);
  const lines = [];
  for (const g of columnGroups) {
    const all = g.items.sort((p, q) => p.x - q.x);
    const its = all.filter((it) => !it.ws);
    if (!its.length) continue;
    // dominant size / baseline by character count
    const weight = new Map();
    for (const it of its) {
      const k = Math.round(it.size * 10) / 10;
      weight.set(k, (weight.get(k) ?? 0) + it.s.length);
    }
    // line size: the largest size carrying >= 30% of the characters, so inline small caps or
    // smaller code spans do not demote a body line, and a single big glyph does not promote it
    const totalChars = [...weight.values()].reduce((a, b) => a + b, 0);
    const size = Math.max(...[...weight].filter(([, n]) => n >= 0.3 * totalChars).map(([k]) => k));
    const main = its.filter((it) => Math.abs(it.size - size) < 0.15 * size);
    const baseY = mode(main.map((it) => Math.round(it.y * 2) / 2));
    let text = "";
    let prev = null;
    let pendingSpace = false;
    let monoChars = 0;
    const parts = [];
    let x2 = -Infinity;
    for (const it of all) {
      if (it.ws) {
        if (prev) pendingSpace = true;
        continue;
      }
      // footnote reference markers: small, raised, numeric
      if (it.size < 0.85 * size && it.y - baseY > 0.15 * size && /^[\d\s,*\u2020\u2021\u00A7-]+$/.test(it.s)) {
        page.droppedAlnum += alnum(it.s);
        continue;
      }
      // fake-bold overprint: same string drawn twice at (almost) the same spot
      if (prev && prev.s === it.s && Math.abs(prev.x - it.x) < 0.5 * size) {
        if (prev.style) prev.style.bold = true; // intentional overprint is a synthetic bold face
        page.droppedAlnum += alnum(it.s);
        continue;
      }
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        const needSpace = pendingSpace || gap > 0.12 * Math.min(prev.size, it.size);
        if (needSpace && !text.endsWith(" ") && !it.s.startsWith(" ")) {
          const spaces = prev.mono && it.mono ? Math.max(1, Math.min(80, Math.round(gap / (0.6 * it.size)))) : 1;
          text += " ".repeat(spaces);
        }
      }
      pendingSpace = false;
      text += it.s;
      parts.push({ text: it.s, x: it.x, x2: it.x + it.w, style: it.style });
      if (it.mono) monoChars += it.s.length;
      x2 = Math.max(x2, it.x + it.w);
      prev = it;
    }
    text = monoChars > totalChars * 0.9 ? text.trim() : text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    // letter-spaced display text: "C H A P T E R" -> "CHAPTER"
    if (monoChars <= totalChars * 0.9 && /^(?:\S ){2,}\S$/.test(text)) text = text.replace(/ /g, "");
    if (monoChars <= totalChars * 0.9) text = text.replace(/\b(?:\p{Lu} ){3,}\p{Lu}\b/gu, (m) => m.replace(/ /g, ""));
    lines.push({
      page: page.num,
      x: its[0].x,
      x2,
      y: baseY,
      size,
      text,
      parts,
      view,
      mono: monoChars > totalChars * 0.9,
      column: g.column,
      gutter: g.gutter,
      top: view[3] - baseY,
      bottom: baseY - view[1],
    });
  }

  // footnote markers raised so far they formed their own "line": drop them
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.size < 0.85 * pageSize && l.text.length <= 4 && /^[\d*\u2020\u2021\u00A7,\s]+$/.test(l.text)) {
      if (lines.some((o) => o !== l && o.size > l.size && Math.abs(o.y - l.y) < 0.8 * o.size && l.x >= o.x - 2 && l.x <= o.x2 + 2 * o.size)) {
        page.droppedAlnum += alnum(l.text);
        lines.splice(i, 1);
      }
    }
  }

  // attach drop caps to the top-most line to their right within their height
  for (const dc of dropCaps) {
    const cands = lines.filter((l) => l.x >= dc.x + dc.w - 2 && l.x <= dc.x + dc.w + 2 * l.size && l.y <= dc.y + dc.size * 0.9 && l.y >= dc.y - 0.3 * dc.size);
    const target = cands.sort((p, q) => q.y - p.y)[0];
    if (target) {
      // "L" + "et's" abut; a drop cap that is a whole word ("A few", "I have") is followed by a real gap
      const gap = target.x - (dc.x + dc.w);
      target.text = dc.s.trim() + (gap > 0.15 * target.size ? " " : "") + target.text;
      target.x = dc.x;
      target.parts.unshift({ text: dc.s.trim(), x: dc.x, x2: dc.x + dc.w, style: dc.style });
    } else {
      lines.push({ page: page.num, x: dc.x, x2: dc.x + dc.w, y: dc.y, size: dc.size, text: dc.s.trim(), mono: false, top: view[3] - dc.y, bottom: dc.y - view[1] });
    }
  }
  lines.sort((p, q) => q.y - p.y || p.x - q.x);
  detectTables(lines, page.num);
  return orderColumns(lines);
}

/**
 * Only infer columns from a repeated gutter separating substantial prose on both sides.
 * A single wide word gap, a table of contents, and short table cells are not enough evidence.
 * Spanning titles retain their own baseline group and divide the page into reading-order bands.
 */
function splitProseColumns(groups, view) {
  const pageWidth = view[2] - view[0];
  const candidates = [];
  for (const g of groups) {
    const items = g.items.filter((it) => !it.ws).sort((a, b) => a.x - b.x);
    for (let i = 1; i < items.length; i++) {
      const left = items.slice(0, i);
      const right = items.slice(i);
      const edge = Math.max(...left.map((it) => it.x + it.w));
      const gap = right[0].x - edge;
      const centre = (right[0].x + edge) / 2;
      if (gap < Math.max(1.5 * g.refSize, 0.03 * pageWidth) || centre < view[0] + 0.3 * pageWidth || centre > view[0] + 0.7 * pageWidth) continue;
      const prose = (side) => {
        const text = side.map((it) => it.s).join(" ");
        return !side.some((it) => it.mono) && text.length >= 25 && text.split(/\s+/).length >= 4;
      };
      if (prose(left) && prose(right)) candidates.push({ left: edge, right: right[0].x });
    }
  }
  if (candidates.length < 4) return groups;
  // Require a common empty vertical strip, rather than merely similar gap centres.
  const gutter = candidates.map((c) => (c.left + c.right) / 2).find((x) => candidates.filter((c) => c.left < x && c.right > x).length >= Math.max(4, candidates.length * 0.75));
  if (gutter == null) return groups;
  const out = [];
  for (const g of groups) {
    const ink = g.items.filter((it) => !it.ws);
    if (ink.some((it) => it.x < gutter && it.x + it.w > gutter)) {
      out.push(g); // heading or other content spanning the gutter
      continue;
    }
    for (const column of [0, 1]) {
      const items = g.items.filter((it) => column === 0 ? it.x < gutter : it.x >= gutter);
      if (items.some((it) => !it.ws)) out.push({ ...g, items, column, gutter });
    }
  }
  return out;
}

/** Repeated aligned short cells are tables, while long prose remains in reading columns. */
function detectTables(lines, page) {
  for (const line of lines) {
    const cells = [];
    for (const part of line.parts ?? []) {
      const prev = cells.at(-1);
      if (prev && part.x - prev.x2 < 2 * line.size) {
        const gap = part.x - prev.x2;
        prev.text += `${gap > 0.12 * line.size && !/\s$/.test(prev.text) && !/^\s/.test(part.text) ? " " : ""}${part.text}`;
        prev.x2 = part.x2;
      } else cells.push({ x: part.x, x2: part.x2, text: part.text });
    }
    line.cells = cells.map((c) => ({ ...c, text: finalText(c.text) }));
  }
  let candidates = [];
  let table = 0;
  const flush = () => {
    const shortCells = candidates.flatMap((l) => l.cells).filter((c) => c.text.split(/\s+/).length <= 3).length;
    const cellCount = candidates.reduce((n, l) => n + l.cells.length, 0);
    if (candidates.length >= 3 && candidates.every((l) => l.cells.every((c) => c.text.length <= 40)) &&
        (candidates[0].cells.length >= 3 || shortCells >= 0.75 * cellCount)) {
      const id = `p${page}-t${++table}`;
      for (const line of candidates) line.tableId = id;
    }
    candidates = [];
  };
  for (const line of lines) {
    if (line.cells.length < 2 || BULLET_RE.test(line.text) || CHAPTER_RE.test(line.text) || PART_RE.test(line.text) || line.column != null) { flush(); continue; }
    const prev = candidates.at(-1);
    if (prev && (prev.cells.length !== line.cells.length || prev.y - line.y > 3 * line.size || line.cells.some((c, i) => Math.abs(c.x - prev.cells[i].x) > line.size))) flush();
    candidates.push(line);
  }
  flush();
}

function orderColumns(lines) {
  if (!lines.some((l) => l.column != null)) return lines;
  const ordered = [];
  let band = [];
  const flush = () => {
    for (const column of [0, 1]) {
      const own = band.filter((l) => l.column === column);
      const body = own.filter((l) => !l.mono);
      const left = Math.min(...(body.length ? body : own).map((l) => l.x));
      const right = Math.max(...(body.length ? body : own).map((l) => l.x2));
      for (const l of own) Object.assign(l, { layoutLeft: left, layoutRight: right });
      ordered.push(...own);
    }
    band = [];
  };
  for (const l of lines) {
    if (l.column == null) {
      flush();
      ordered.push(l);
    } else band.push(l);
  }
  flush();
  return ordered;
}

// ---------------------------------------------------------------------------------------------
// Stage 3: running headers / footers / page numbers

function removeHeadersFooters(pages, warnings) {
  const PAGE_NO_RE = /^(?:page\s*)?[\divxlcdm]{1,6}(?:\s*(?:of|\/)\s*\d+)?$/i;
  const keyOf = (text) =>
    text
      .toLowerCase()
      .replace(/\d+/g, "#")
      .replace(/\b[ivxlcdm]+\b/g, "#") // roman page numbers in front matter
      .replace(/\s+/g, " ")
      .replace(/^[\s\-\u2013\u2014|\u2022\u00B7]+|[\s\-\u2013\u2014|\u2022\u00B7]+$/g, "");
  const zoneOf = (pg, ln) => {
    const h = pg.view[3] - pg.view[1];
    if (ln.top <= 0.12 * h + ln.size) return "T";
    if (ln.bottom <= 0.12 * h) return "B";
    return null;
  };
  // running heads are body-size or smaller; display text (chapter labels/numbers) never is
  const sizeW = new Map();
  for (const pg of pages) for (const l of pg.lines) sizeW.set(Math.round(l.size * 2) / 2, (sizeW.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.length);
  const body = [...sizeW].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const stats = new Map();
  for (const pg of pages) {
    const n = pg.lines.length;
    const cand = n <= 4 ? pg.lines : [...pg.lines.slice(0, 2), ...pg.lines.slice(-2)];
    for (const ln of cand) {
      const zone = zoneOf(pg, ln);
      if (!zone || ln.size > 1.1 * body) continue;
      const k = PAGE_NO_RE.test(ln.text.trim()) ? `${zone}:#pageno` : `${zone}:${keyOf(ln.text)}`;
      ln._hf = k;
      if (!stats.has(k)) stats.set(k, []);
      stats.get(k).push(ln);
    }
  }
  let removed = 0;
  const patterns = [];
  for (const [k, lns] of stats) {
    const pagesSeen = new Set(lns.map((l) => l.page));
    if (pagesSeen.size < 3) continue;
    // must sit at a consistent vertical position (a chapter heading that matches the running head will not)
    const ys = lns.map((l) => Math.round(l.y / 4) * 4);
    const ym = mode(ys);
    const consistent = lns.filter((l) => Math.abs(l.y - ym) <= 6 || k.endsWith("#pageno"));
    if (new Set(consistent.map((l) => l.page)).size < 3) continue;
    for (const l of consistent) l._remove = true;
    removed += consistent.length;
    patterns.push(k);
  }

  // Running heads of short chapters repeat too rarely for the rule above ("xxii Introduction").
  // They still carry the printed page number, whose offset from the physical page is constant
  // over long runs of the book; a margin line led or trailed by a number with such an offset goes.
  const numberOf = (tok) => {
    if (/^\d{1,4}$/.test(tok)) return { kind: "arabic", v: Number(tok) };
    if (/^[ivxlc]{1,7}$/i.test(tok)) return { kind: "roman", v: romanToInt(tok) };
    return null;
  };
  const offsetCount = new Map();
  const tagged = [];
  for (const pg of pages) {
    for (const ln of pg.lines) {
      if (ln._remove || !ln._hf || ln.text.length > 90) continue;
      const toks = ln.text.split(" ");
      for (const tok of new Set([toks[0], toks.at(-1)])) {
        const n = numberOf(tok);
        if (!n || !n.v) continue;
        const key = `${n.kind}:${n.v - pg.num}`;
        offsetCount.set(key, (offsetCount.get(key) ?? new Set()).add(pg.num));
        tagged.push({ ln, key });
      }
    }
  }
  for (const { ln, key } of tagged) {
    if (!ln._remove && offsetCount.get(key).size >= 3) {
      ln._remove = true;
      removed++;
    }
  }
  for (const pg of pages) {
    for (const l of pg.lines) if (l._remove) pg.hfAlnum += alnum(l.text);
    pg.lines = pg.lines.filter((l) => !l._remove);
  }
  return { removed, patterns };
}

function romanToInt(s) {
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) {
    const cur = v[t[i]];
    const next = v[t[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Stage 4: book-level statistics

function bookStats(pages) {
  const w = new Map();
  for (const pg of pages)
    for (const l of pg.lines) {
      const k = Math.round(l.size * 2) / 2;
      w.set(k, (w.get(k) ?? 0) + l.text.length);
    }
  const bodySize = [...w.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const isBody = (l) => Math.abs(l.size / bodySize - 1) < 0.1;

  const leadings = [];
  const pageGaps = new Map();
  for (const pg of pages) {
    const body = pg.lines.filter(isBody);
    const gaps = [];
    for (let i = 1; i < body.length; i++) {
      const d = body[i - 1].y - body[i].y;
      if (d > 0.6 * bodySize && d < 4 * bodySize) gaps.push(Math.round(d * 2) / 2);
    }
    pageGaps.set(pg, gaps);
    leadings.push(...gaps.filter((d) => d < 3 * bodySize));
  }
  const leading = mode(leadings) ?? bodySize * 1.2;
  // a page set with looser line spacing (e.g. a double-spaced foreword) gets its own leading:
  // the smallest gap that occurs 3+ times on the page, if clearly larger than the book's
  for (const [pg, gaps] of pageGaps) {
    const counts = new Map();
    for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
    const common = [...counts].filter(([, n]) => n >= 3).map(([g]) => g).sort((a, b) => a - b)[0];
    if (common && common > 1.3 * leading) pg.leading = common;
  }

  // per-page left/right text edges, with odd/even fallbacks for sparse pages
  const parity = { 0: { l: [], r: [] }, 1: { l: [], r: [] } };
  for (const pg of pages) {
    const body = pg.lines.filter((l) => isBody(l) && !l.mono);
    pg.leftEdge = body.length >= 4 ? mode(body.map((l) => Math.round(l.x))) : null;
    pg.rightEdge = body.length >= 4 ? Math.max(...body.map((l) => l.x2)) : null;
    if (pg.leftEdge != null) parity[pg.num % 2].l.push(pg.leftEdge);
    if (pg.rightEdge != null) parity[pg.num % 2].r.push(Math.round(pg.rightEdge));
  }
  const fallback = { 0: { l: mode(parity[0].l), r: mode(parity[0].r) }, 1: { l: mode(parity[1].l), r: mode(parity[1].r) } };
  let fullLines = 0;
  let bodyCount = 0;
  let indented = 0;
  for (const pg of pages) {
    pg.leftEdge ??= fallback[pg.num % 2].l ?? fallback[(pg.num + 1) % 2].l ?? 0;
    pg.rightEdge ??= fallback[pg.num % 2].r ?? fallback[(pg.num + 1) % 2].r ?? 1e9;
    for (const l of pg.lines) {
      if (!isBody(l) || l.mono) continue;
      bodyCount++;
      if (pg.rightEdge - l.x2 < 0.8 * l.size) fullLines++;
      const ind = l.x - pg.leftEdge;
      if (ind > 0.6 * l.size && ind < 4 * l.size) indented++;
    }
  }
  return {
    bodySize,
    isBody,
    leading,
    justified: bodyCount > 0 && fullLines / bodyCount > 0.45,
    indentStyle: bodyCount > 0 && indented / bodyCount > 0.02,
  };
}

// ---------------------------------------------------------------------------------------------
// Stage 5: text repairs that need whole-book statistics

/**
 * Some PDFs carry a wrong advance width for one glyph (Principles: every "y" is followed by a gap
 * of ~0.12em), so pdf.js inserts a fake space after it: "psy chology", "y ears", "way s".
 * Signature: a common letter that (almost) never appears word-internally. Each "a b" split after
 * that letter is then judged with evidence from the book itself: is "a" seen as a complete word
 * (line end / before punctuation), is "b" seen starting words elsewhere, is "b" a suffix fragment.
 */
function repairFakeSpaces(pages, warnings) {
  const allLines = pages.flatMap((p) => p.lines).filter((l) => !l.mono);
  const internal = new Map();
  const spaced = new Map();
  for (const l of allLines) {
    for (const m of l.text.matchAll(/(\p{Ll})(?=(\p{Ll})|( \p{Ll}))/gu)) {
      const ch = m[1];
      if (m[2]) internal.set(ch, (internal.get(ch) ?? 0) + 1);
      else spaced.set(ch, (spaced.get(ch) ?? 0) + 1);
    }
  }
  // the split also leaves the letter standing alone before a word ("y ou", "y ears"), which real
  // text almost never does; requiring that too keeps word-final-heavy vocabularies from triggering it
  const lone = new Map();
  for (const l of allLines) for (const m of l.text.matchAll(/(?:^|\s)(\p{L})\s\p{Ll}/gu)) lone.set(m[1].toLowerCase(), (lone.get(m[1].toLowerCase()) ?? 0) + 1);
  const bad = [];
  for (const [ch, sp] of spaced) {
    const inn = internal.get(ch) ?? 0;
    if (ch === "s" || ch === "a" || ch === "i") continue; // word-final "s"; "a" and "I" are words
    if (sp + inn > 300 && inn / (sp + inn) < 0.1 && (lone.get(ch) ?? 0) >= Math.max(10, 0.01 * sp)) bad.push(ch);
  }
  if (!bad.length) return;

  const strip = (t) => t.replace(/^[^\p{L}]+|[^\p{L}'\u2019-]+$/gu, "").toLowerCase();
  const badClass = `[${bad.join("")}${bad.join("").toUpperCase()}]`;
  const endsBad = new RegExp(`${badClass}$`, "u");
  // lookahead for the tail so overlapping pairs ("way y ou", "my caddy ing") are each considered
  const pairRe = new RegExp(`([\\p{L}'\u2019]*${badClass}) (?=([-/]?\\p{Ll}[\\p{L}'\u2019-]*))`, "gu");
  // evidence that a token is a complete word: it ends a line or precedes punctuation
  const complete = new Set();
  // evidence that a lowercase token starts a word: it begins a line or follows a token that cannot produce a fake split
  const starts = new Map();
  for (const l of allLines) {
    const toks = l.text.split(" ");
    toks.forEach((t, i) => {
      if (i === toks.length - 1 || /[^\p{L}'\u2019]$/u.test(t)) complete.add(strip(t));
      const lead = t.replace(/^[^\p{L}]+/u, "");
      if (/^\p{Ll}/u.test(lead) && (i === 0 || !endsBad.test(toks[i - 1]))) { const w = strip(t); starts.set(w, (starts.get(w) ?? 0) + 1); }
    });
  }
  // a long head followed by an attested word somewhere is itself a word ("believability weighted")
  const headWords = new Set();
  for (const l of allLines) for (const m of l.text.matchAll(pairRe)) if (starts.has(strip(m[2]))) headWords.add(strip(m[1]));
  // fragments a fake split typically leaves behind a long word ("employ ees", "terrify ing", "my self")
  const SUFFIX = /^(?:s|es|ed|er|ers|ing|ings|ment|ments|ness|able|ably|ance|ances|ant|ants|al|als|ally|ful|less|ist|ists|ism|isms|ize|ized|izes|izing|ee|ees|ology|ologies|ologist|ologists|ological|ically|ical|ic|ics|ous|ously|ation|ations|ish|ies|ied|self|selves)$/;
  /** Decide whether "a b" is one word split by a fake space. */
  const shouldJoin = (a, b) => {
    if (/^[-/]/.test(b)) return true; // "easy -credit", "community /company"
    if (/^(?:any|every|some|no)$/.test(a) && /^(?:thing|things|where|body|one|how)$/.test(b)) return true; // "any thing"
    if (b.length === 1 && endsBad.test(b)) return false; // "way y ou": the lone letter heads the next word
    if (a.length === 1) return true; // "y ou", "y ears": a lone letter is never the word
    if (b.length === 1 && b !== "a" && b !== "i") return true; // "alway s", "day s"
    const aWord = complete.has(a) || (a.length > 3 && headWords.has(a));
    // short non-word heads ("sy stem", "psy chology", "ey es") join unless the tail is a common word ("guy who")
    if (!aWord && a.length <= 3) return (starts.get(b) ?? 0) < 10;
    if (starts.has(b)) return false; // b is attested as a word start: "identify the", "really want"
    if (SUFFIX.test(b)) return true; // "employ ees", "say ing", "my self"
    if (a.length >= 6) return false; // long heads are mostly real words: "pituitary gland", "routinely criticized"
    return !aWord; // "analy tical" joins; "by observing" stays apart
  };
  const re = pairRe;
  let fixes = 0;
  for (const l of allLines) {
    for (let pass = 0; pass < 3; pass++) {
      const before = l.text;
      l.text = l.text.replace(re, (m, a, b) => {
        if (!shouldJoin(strip(a), /^[-/]/.test(b) ? b : strip(b))) return m;
        fixes++;
        return a;
      });
      if (l.text === before) break;
    }
  }
  if (fixes) warnings.push(`Repaired ${fixes} spurious spaces after "${bad.join('", "')}" caused by broken font metrics in this PDF.`);
}

/** Word counts from line interiors, used to decide whether a line-end hyphen is real. */
function buildLexicon(pages) {
  const counts = new Map();
  const add = (w) => {
    if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
  };
  let prevHyph = false;
  for (const pg of pages)
    for (const l of pg.lines) {
      const toks = l.text.split(" ");
      toks.forEach((t, i) => {
        if (i === 0 && prevHyph) return;
        if (i === toks.length - 1 && /\p{L}-$/u.test(t)) return;
        const w = t.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, "").toLowerCase();
        add(w);
        if (w.includes("-")) w.split("-").forEach(add);
      });
      prevHyph = /\p{L}-$/u.test(l.text);
    }
  return counts;
}

/** Join two consecutive lines of the same paragraph. */
function joinLines(a, b, lex) {
  if (!a) return b;
  if (a.endsWith("\u00AD")) return a.slice(0, -1) + b;
  if (/[\u2014]$/.test(a) || /^[\u2014]/.test(b)) return a + b;
  const hy = a.match(/([\p{L}\d'\u2019.\/:]+)-$/u);
  if (hy && !/\s-$/.test(a)) {
    const left = hy[1];
    if (/[\/.:]/.test(left) || !/^\p{Ll}/u.test(b)) return a + b; // URL / "SHA-" + "1" / "pre-" + "COVID": keep the hyphen
    if (/^(?:and|or|nor|to)\s/.test(b)) return `${a} ${b}`; // suspended hyphen: "second- and third-order"
    const right = (b.match(/^[\p{L}'\u2019-]+/u)?.[0] ?? "").replace(/[-'\u2019]+$/, "");
    const L = left.toLowerCase();
    const R = right.toLowerCase();
    const cJoined = lex.get(L + R) ?? 0;
    const cHyph = lex.get(`${L}-${R}`) ?? 0;
    let keep;
    if (cHyph > cJoined) keep = true;
    else if (cJoined > 0) keep = false;
    else {
      const lastL = L.split("-").pop();
      const firstR = R.split("-")[0];
      keep = lastL.length > 1 && firstR.length > 1 && (lex.get(lastL) ?? 0) >= 2 && (lex.get(firstR) ?? 0) >= 2;
    }
    return keep ? a + b : a.slice(0, -1) + b;
  }
  return `${a} ${b}`;
}

// ---------------------------------------------------------------------------------------------
// Stage 6: structure (chapters + headings)

/** Heading-ish line groups on a page: consecutive lines of the same "large" size. */
function headingGroups(pg, stats, minRatio) {
  const groups = [];
  let cur = null;
  pg.lines.forEach((l, i) => {
    const large = l.size >= minRatio * stats.bodySize && l.text.length <= 160;
    if (!large) {
      cur = null;
      return;
    }
    const prev = pg.lines[i - 1];
    if (cur && prev && prev.y - l.y <= 2.6 * Math.max(l.size, prev.size)) {
      cur.lines.push(l);
      cur.text += ` ${l.text}`;
      cur.size = Math.max(cur.size, l.size);
    } else {
      cur = { page: pg.num, lines: [l], text: l.text, size: l.size, y: l.y, firstOnPage: pg.lines.slice(0, i).every((x) => !stats.isBody(x)) };
      groups.push(cur);
    }
  });
  return groups;
}

/** Find a title on a page; returns the matched lines (best match) or null. */
function findTitle(pg, title, stats, { strict, nearTop = null }) {
  const key = normKey(title);
  if (key.length < 2) return null;
  const lines = pg.lines;
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    let acc = "";
    for (let j = i; j < Math.min(lines.length, i + 4); j++) {
      if (strict && lines[j].size < 1.1 * stats.bodySize) break;
      if (j > i && lines[j - 1].y - lines[j].y > 4.5 * Math.max(lines[j].size, lines[j - 1].size)) break; // chapter openers are airy
      acc += normKey(lines[j].text);
      let score = 0;
      if (acc === key) score = 3;
      // "CHAPTER 1 Title" (label before) or "Title: subtitle" (subtitle after)
      else if (acc.length > key.length && acc.length <= key.length + 24 && (acc.endsWith(key) || acc.startsWith(key))) score = 2;
      else if (strict && j === i && key.startsWith(acc) && acc.length >= Math.max(6, 0.55 * key.length)) score = 1;
      if (!strict && score < 3) score = 0; // lenient mode: whole-line exact matches only
      if (!score) continue;
      const size = Math.max(...lines.slice(i, j + 1).map((l) => l.size));
      const dist = nearTop == null ? 0 : Math.abs(lines[i].y - nearTop);
      const rank = score * 1000 + size * 10 - dist / 10;
      if (!best || rank > best.rank) best = { rank, lines: lines.slice(i, j + 1), y: lines[i].y + lines[i].size };
      if (acc.length >= key.length) break;
    }
  }
  return best;
}

const isBareNumber = (t) => /^(?:\d{1,3}|[ivxlc]{1,6})\.?$/i.test(t.trim());

/** Outline -> chapter starts + heading marks. Returns null when the outline is unusable. */
function structureFromOutline(outline, pages, stats, numPages, warnings) {
  if (outline.length < 2) return null;
  // 1. merge "1" | "It's All Invented" style pairs (siblings at the same depth)
  const entries = [];
  for (let i = 0; i < outline.length; i++) {
    const e = outline[i];
    const n = outline[i + 1];
    if (isBareNumber(e.title) && n && n.depth === e.depth && !isBareNumber(n.title) && e.children.length === 0) {
      // merge in place so parent/child links stay valid; the number entry disappears
      if (n.page == null) Object.assign(n, { page: e.page, top: e.top });
      Object.assign(n, { title: `${e.title.replace(/\.$/, "")}. ${n.title}`, merged: true });
      if (e.parent) e.parent.children = e.parent.children.filter((c) => c !== e);
      entries.push(n);
      i++;
    } else entries.push(e);
  }
  const mergedPairs = entries.filter((e) => e.merged).length;
  if (mergedPairs) warnings.push(`Merged ${mergedPairs} split outline entries (number + title) into single chapter titles.`);

  // 2. is the destination data trustworthy?
  const top = entries.filter((e) => e.depth === 0);
  const withPage = entries.filter((e) => e.page != null);
  const distinctTop = new Set(top.filter((e) => e.page != null).map((e) => e.page)).size;
  let violations = 0;
  for (let i = 1; i < withPage.length; i++) if (withPage[i].page < withPage[i - 1].page) violations++;
  const unreliable =
    withPage.length < 0.6 * entries.length || (top.length >= 4 && distinctTop < 0.5 * top.length) || violations > 0.2 * withPage.length;
  // When broken, destinations typically collapse onto one page; the rest may still be right.
  const freq = new Map();
  for (const e of withPage) freq.set(e.page, (freq.get(e.page) ?? 0) + 1);
  const collapsed = new Set([...freq].filter(([, n]) => unreliable && n >= 3 && n >= 0.2 * entries.length).map(([p]) => p));
  for (const e of entries) e.trusted = e.page != null && !collapsed.has(e.page);
  // a trusted destination must not go backwards relative to the previous trusted one
  let last = 0;
  for (const e of entries) {
    if (!e.trusted) continue;
    if (e.page < last) e.trusted = false;
    else last = e.page;
  }

  // 3. locate untrusted entries in the text, between their trusted neighbours
  let located = 0;
  let dropped = 0;
  let cursor = 1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.trusted) {
      e.y = e.top;
      cursor = e.page;
      continue;
    }
    const upper = entries.slice(i + 1).find((x) => x.trusted)?.page ?? numPages;
    let hit = null;
    for (let p = Math.max(1, cursor); p <= upper && !hit; p++) {
      const m = findTitle(pages[p - 1], e.title.replace(/^\d+\.\s/, ""), stats, { strict: true });
      if (m) hit = { page: p, y: m.y };
    }
    if (hit) {
      e.page = hit.page;
      e.y = hit.y;
      cursor = hit.page;
      located++;
    } else {
      e.page = null;
      dropped++;
    }
  }
  if (unreliable) {
    warnings.push(
      `Outline destinations are broken (they point to the wrong pages); located ${located} of ${entries.length} outline titles in the text instead.`,
    );
  } else if (located) warnings.push(`${located} outline entries had no usable destination and were located by title in the text.`);
  if (dropped) warnings.push(`${dropped} outline entries could not be placed and were ignored.`);
  const placed = entries.filter((e) => e.page != null);
  if (placed.length < 2) return null;

  // 4. choose chapter depth: expand top-level "Part" containers into their children
  const spanOf = (list, end) => list.map((c, i) => (list[i + 1]?.page ?? end) - c.page);
  const chapters = [];
  const marks = [];
  const topPlaced = placed.filter((e) => e.depth === 0);
  topPlaced.forEach((t, ti) => {
    const kids = t.children.filter((c) => c.page != null);
    const partLike = PART_RE.test(t.title) || /^part\b/i.test(t.title);
    const end = topPlaced[ti + 1]?.page ?? numPages + 1;
    const expand = kids.length >= 2 && (partLike || median(spanOf(kids, end)) >= 8);
    chapters.push({ title: t.title, page: t.page, y: t.y, isPart: expand });
    const chapterDepth = expand ? 1 : 0;
    if (expand) {
      marks.push({ title: t.title, page: t.page, y: t.y, level: 1 });
      for (const k of kids) {
        chapters.push({ title: k.title, page: k.page, y: k.y });
        collectMarks(k, chapterDepth, marks);
      }
    } else collectMarks(t, chapterDepth, marks);
  });
  // entries whose top-level ancestor was lost still count as chapters
  if (!topPlaced.length) for (const e of placed) chapters.push({ title: e.title, page: e.page, y: e.y });
  return { chapters, marks, source: "outline" };

  function collectMarks(entry, chapterDepth, acc) {
    acc.push({ title: entry.title, page: entry.page, y: entry.y, level: 1 });
    const walk = (node) => {
      for (const c of node.children) {
        if (c.page != null) acc.push({ title: c.title, page: c.page, y: c.y, level: Math.min(3, c.depth - chapterDepth + 1) });
        walk(c);
      }
    };
    walk(entry);
  }
}

/** No (usable) outline: chapters from "Chapter N" lines or the dominant top-of-page heading size. */
function structureFromText(pages, stats, numPages, warnings) {
  const isLarge = (l) => l.size >= 1.1 * stats.bodySize;
  const sameSize = (a, b) => Math.abs(a.size - b.size) <= 0.06 * Math.max(a.size, b.size);
  const isLabelLine = (t) => CHAPTER_RE.test(t) || PART_RE.test(t) || /^(?:chapter|part)$/i.test(t);
  // full title of a heading starting at line i: "CHAPTER" + "1" + "Introduction to Antivirus" + "Software",
  // or a title that wraps over several lines of the same size ("CHAPTER IX. THE WORLD OF" + "UNIVERSALS")
  const titleFrom = (pg, i) => {
    let title = pg.lines[i].text;
    let last = pg.lines[i];
    for (let j = i + 1; j < Math.min(pg.lines.length, i + 5); j++) {
      const l = pg.lines[j];
      const gap = last.y - l.y;
      if (!isLarge(l) || gap > 4.5 * Math.max(l.size, last.size)) break;
      if (/^(?:chapter|part)$/i.test(title) && /^(?:\d+|[ivxlc]+)$/i.test(l.text)) title = `${title} ${l.text}`;
      else if (normKey(title).length <= 14) title = `${title}: ${l.text}`; // "CHAPTER 3" + its title
      else if (sameSize(l, last) && gap <= 2 * l.size) title = `${title} ${l.text}`; // wrapped title line
      else break;
      last = l;
    }
    return title;
  };

  // a) explicit "Chapter N" / "Part N" headings anywhere on a page. Contents pages list every chapter
  //    in body type, so a label in body type only counts at the top of a page that is not a contents page.
  const chapterHits = [];
  const partHits = [];
  for (const pg of pages) {
    const labels = pg.lines.filter((l) => isLabelLine(l.text));
    const bodyLabels = labels.filter((l) => !isLarge(l)).length;
    // three or more labels on one page is a contents list; only a heading set larger than all of
    // its entries survives there (Russell's "CHAPTER I." below a body-type contents list)
    const tocSizes = labels.length >= 3 ? labels.map((l) => l.size).sort((a, b) => b - a) : null;
    for (let i = 0; i < pg.lines.length; i++) {
      const l = pg.lines[i];
      if (!isLabelLine(l.text) || l.text.length >= 120) continue;
      if (tocSizes && !(l.size === tocSizes[0] && tocSizes[0] > 1.1 * tocSizes[1])) continue;
      if (/^(?:chapter|part)$/i.test(l.text) && !/^(?:\d+|[ivxlc]+)$/i.test(pg.lines[i + 1]?.text ?? "")) continue;
      const display = isLarge(l) || (i < 3 && bodyLabels < 3 && pg.lines[i + 1] && isLarge(pg.lines[i + 1]));
      if (!display) continue;
      const title = titleFrom(pg, i);
      (PART_RE.test(title) ? partHits : chapterHits).push({ title, page: pg.num, y: l.y + l.size, size: Math.max(l.size, pg.lines[i + 1]?.size ?? 0) });
    }
  }
  // a part title repeated later (summary pages) is not a new part
  const seenParts = new Set();
  const uniqueParts = partHits.filter((h) => !seenParts.has(normKey(h.title)) && seenParts.add(normKey(h.title)));
  if (chapterHits.length >= 3) {
    // front/back matter set in the same style as the chapter headings ("PREFACE", "BIBLIOGRAPHICAL NOTE")
    const tier = median(chapterHits.map((h) => h.size));
    const extra = [];
    for (const pg of pages) {
      pg.lines.forEach((l, i) => {
        if (isLarge(l) && Math.abs(l.size - tier) <= 0.06 * tier && MATTER_RE.test(l.text.trim()) && !chapterHits.some((h) => h.page === pg.num && Math.abs(h.y - (l.y + l.size)) < 1))
          extra.push({ title: titleFrom(pg, i), page: pg.num, y: l.y + l.size });
      });
    }
    const starts = [...chapterHits, ...uniqueParts, ...extra].sort((x, y) => x.page - y.page || y.y - x.y);
    warnings.push(`No usable outline; ${chapterHits.length} chapters detected from "Chapter N" headings.`);
    return { chapters: starts, marks: starts.map((c) => ({ ...c, level: 1 })), source: "pattern" };
  }

  // b) title pages: pages whose only content is one to three display lines; consecutive ones
  //    ("THE FIRST PRACTICE" / "It's All Invented") open the same chapter
  // (a display quotation on a page of its own is not a title)
  const titlePages = pages.filter((pg) => pg.lines.length >= 1 && pg.lines.length <= 3 && pg.lines.every(isLarge) && pg.lines.map((l) => l.text).join(" ").length <= 80);
  const runs = [];
  for (const pg of titlePages) {
    const last = runs.at(-1);
    if (last && last.lastPage === pg.num - 1) {
      last.title += ` ${pg.lines.map((l) => l.text).join(" ")}`;
      last.lastPage = pg.num;
    } else runs.push({ title: pg.lines.map((l) => l.text).join(" "), page: pg.num, lastPage: pg.num, y: null });
  }
  if (runs.length >= 3 && runs.length <= numPages / 4) {
    warnings.push(`No usable outline; ${runs.length} chapters detected from chapter title pages.`);
    return { chapters: [...runs, ...uniqueParts].sort((x, y) => x.page - y.page), marks: [], source: "titlepages" };
  }

  // c) the largest heading size that recurs at the top of pages, spaced like chapters
  const tiers = new Map();
  for (const pg of pages)
    for (const g of headingGroups(pg, stats, 1.2)) {
      if (!g.firstOnPage) continue;
      const k = Math.round(g.size * 2) / 2;
      if (!tiers.has(k)) tiers.set(k, []);
      tiers.get(k).push(g);
    }
  const sorted = [...tiers.entries()].sort((x, y) => y[0] - x[0]);
  for (let i = 0; i < sorted.length; i++) {
    const [size, gs] = sorted[i];
    if (gs.length < 3 || gs.length > numPages / 4) continue;
    // include rarer, larger tiers that also open pages (e.g. part titles) as chapters too
    const starts = sorted
      .slice(0, i + 1)
      .flatMap(([, g]) => g)
      .sort((x, y) => x.page - y.page || y.y - x.y);
    const spacing = median(starts.slice(1).map((g, k) => g.page - starts[k].page));
    if (spacing < 3) continue;
    warnings.push(`No usable outline; ${starts.length} chapters detected from heading font size (${size}pt vs body ${stats.bodySize}pt).`);
    return {
      chapters: starts.map((g) => ({ title: g.text, page: g.page, y: g.y + g.size })),
      marks: starts.map((g) => ({ title: g.text, page: g.page, y: g.y + g.size, level: 1 })),
      source: "headings",
    };
  }

  // d) last resort: fixed page ranges
  const span = numPages <= 60 ? 10 : 20;
  const chapters = [];
  for (let p = 1; p <= numPages; p += span) chapters.push({ title: `Pages ${p}\u2013${Math.min(numPages, p + span - 1)}`, page: p, y: null });
  warnings.push(`No outline and no recognisable chapter headings; split into fixed ${span}-page sections.`);
  return { chapters, marks: [], source: "ranges" };
}

/** Mark lines that are outline headings, so the block builder emits them as headings. */
function applyMarks(marks, pages, stats) {
  let n = 0;
  for (const m of marks) {
    if (m.page == null) continue;
    for (const p of [m.page, m.page + 1]) {
      const pg = pages[p - 1];
      if (!pg) continue;
      const hit = findTitle(pg, m.title.replace(/^\d+\.\s/, ""), stats, { strict: true, nearTop: m.y }) ?? findTitle(pg, m.title, stats, { strict: false, nearTop: m.y });
      if (hit) {
        const id = `m${n++}`;
        for (const l of hit.lines) if (!l.headingLevel || l.headingLevel > m.level) Object.assign(l, { headingLevel: m.level, headingId: id });
        if (p === m.page) m.matchY = hit.y;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 7: lines -> blocks

/** Keep figures between paragraphs without changing the detected column reading order. */
function prepareFigureBreaks(pages, stats) {
  for (const pg of pages) {
    const figures = (pg.figures ?? []).filter((f) => !f.scanned);
    for (let i = 0; i < pg.lines.length; i++) {
      const line = pg.lines[i];
      const prev = pg.lines[i - 1];
      const local = figures.filter((f) => line.gutter == null || (line.column === 0 ? f.x < line.gutter : f.x + f.width > line.gutter));
      if (local.some((f) => line.y < f.y && (!prev || prev.column !== line.column || prev.y >= f.y - f.height))) line.figureBreak = true;
      if (!/^(?:fig(?:ure)?\.?|table|plate|illustration)\s*(?:\d+|[IVX]+)\b/i.test(line.text) ||
          !local.some((f) => line.y <= f.y - f.height && f.y - f.height - line.y < 5 * line.size)) continue;
      const captionId = `p${pg.num}-caption${i}`;
      const fontKey = (l) => {
        const weights = new Map();
        for (const part of l.parts ?? []) {
          const key = JSON.stringify(part.style ?? {});
          weights.set(key, (weights.get(key) ?? 0) + part.text.replace(/\s/g, "").length);
        }
        return [...weights].sort((a, b) => b[1] - a[1])[0]?.[0];
      };
      const centered = (l) => Math.abs((l.x + l.x2) / 2 - (l.view[0] + l.view[2]) / 2) < 2 * l.size;
      let previous = line;
      Object.assign(line, { captionId, format: "caption" });
      for (let j = i + 1; j < pg.lines.length; j++) {
        const next = pg.lines[j];
        const gap = previous.y - next.y;
        const sameFont = fontKey(previous) === fontKey(next) && Math.abs(previous.size - next.size) < 0.1 * previous.size;
        const centeredWrap = centered(previous) && centered(next) && Math.abs((previous.x + previous.x2) / 2 - (next.x + next.x2) / 2) < 1.5 * next.size;
        const leftWrap = Math.abs(previous.x - next.x) < 0.5 * next.size && !TERMINAL_RE.test(previous.text) && /^\p{Ll}/u.test(next.text);
        if (next.column !== line.column || next.figureBreak || gap < 0 || gap > 1.8 * (pg.leading ?? stats.leading) ||
            !sameFont || (!centeredWrap && !leftWrap) || /^(?:fig(?:ure)?\.?|table)\s*\d/i.test(next.text)) break;
        Object.assign(next, { captionId, format: "caption" });
        previous = next;
      }
    }
  }
}

function insertFigures(blocks, pages) {
  const out = [...blocks];
  for (const pg of pages) {
    const gutter = pg.lines.find((l) => l.gutter != null)?.gutter;
    // Left-column figures are inserted first; original scans follow their recovered text.
    const figures = [...(pg.figures ?? [])].sort((a, b) => {
      const column = (f) => gutter == null || f.x < gutter ? 0 : 1;
      return column(a) - column(b) || b.y - a.y;
    });
    for (const figure of figures) {
      const column = gutter == null ? null : figure.x + figure.width <= gutter ? 0 : figure.x >= gutter ? 1 : null;
      let insertion = -1;
      let lastOnPage = -1;
      for (let i = 0; i < out.length; i++) {
        const block = out[i];
        const ownLines = (block.lines ?? []).filter((l) => l.page === pg.num);
        if (block.page === pg.num || ownLines.length) lastOnPage = i;
        if (figure.scanned) continue;
        const line = ownLines[0] ?? (block.page === pg.num ? block : null);
        if (!line || line.kind === "image") continue;
        if (column != null && line.column != null && line.column < column) continue;
        if (line.y <= figure.y || (column === 0 && line.column === 1)) {
          insertion = i;
          break;
        }
      }
      if (insertion < 0) insertion = lastOnPage >= 0 ? lastOnPage + 1 : out.findIndex((b) => b.page > pg.num);
      if (insertion < 0) insertion = out.length;
      const additions = [figure];
      // Visual extraction already checks OCR labels against the native text. A native chart
      // title does not mean its raster axis labels or legend were recovered from the text layer.
      if (!figure.scanned && figure.image.ocrText) additions.push({
        kind: "body", text: figure.image.ocrText.slice(0, 1000), format: "figure-text",
        page: pg.num, y: figure.y - figure.height, nLines: 1,
      });
      out.splice(insertion, 0, ...additions);
    }
  }
  for (const block of out) {
    if (!/^(?:fig(?:ure)?\.?|table|plate|illustration)\s*(?:\d+|[IVX]+)\b/i.test(block.text)) continue;
    const size = block.size ?? 12;
    if (pages[block.page - 1]?.figures?.some((f) => !f.scanned && block.y <= f.y - f.height && f.y - f.height - block.y < 5 * size)) block.format = "caption";
  }
  return out;
}

function buildBlocks(pages, stats, starts, lex) {
  // headings without an outline match: level from size relative to body text
  const tierLevel = (size) => (size >= 1.6 * stats.bodySize ? 1 : size >= 1.12 * stats.bodySize ? 2 : 3);
  const isLabel = (t) => /^(?:(?:chapter|part|book|section)\s*(?:\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)?|\d{1,3}|[ivxlc]{1,6})\.?$/i.test(t.trim());
  const blocks = [];
  let cur = null;
  let deferred = []; // footnote-like small blocks held back while a paragraph continues across a page break
  let startIdx = 0;
  const flush = () => {
    if (!cur) return;
    blocks.push(cur);
    cur = null;
    if (deferred.length) {
      blocks.push(...deferred);
      deferred = [];
    }
  };
  let carryDropCap = null;
  for (const [pi, pg] of pages.entries()) {
    const lines = pg.lines;
    // An original scan belongs to this page, so its recovered text cannot straddle that figure.
    if (pg.figures?.some((f) => f.scanned) || pages[pi - 1]?.figures?.some((f) => f.scanned)) flush();
    // a drop cap orphaned at the bottom of the previous page (its line starts the next page)
    if (carryDropCap && lines.length) {
      const first = lines.find((x) => stats.isBody(x));
      if (first && !first.text.startsWith(carryDropCap)) first.text = carryDropCap + first.text;
      else pages[pi - 1].droppedAlnum += alnum(carryDropCap);
    }
    carryDropCap = null;
    const last = lines.at(-1);
    if (last && /^\p{Lu}$/u.test(last.text) && last.size >= 1.8 * stats.bodySize && pages[pi + 1]) {
      carryDropCap = last.text;
      lines.pop();
    }
    // trailing small-print lines below the last body line are footnotes: defer them
    let lastBody = -1;
    lines.forEach((l, i) => {
      if (stats.isBody(l)) lastBody = i;
    });
    // ...but only when the small print starts with a note marker ("12 Smith, ...", "* See ...")
    const fnHead = lastBody >= 0 ? lines[lastBody + 1] : null;
    const fnStart =
      fnHead && fnHead.size < 0.85 * stats.bodySize && fnHead.bottom < (pg.view[3] - pg.view[1]) * 0.35 && /^(?:\d{1,3}\.?|[*\u2020\u2021\u00A7])\s?\S/.test(fnHead.text)
        ? lastBody + 1
        : -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const layout = l.layoutLeft != null ? { ...pg, leftEdge: l.layoutLeft, rightEdge: l.layoutRight } : pg;
      const prev = i > 0 ? lines[i - 1] : null;
      let forced = false;
      while (startIdx < starts.length && (starts[startIdx].page < pg.num || (starts[startIdx].page === pg.num && (starts[startIdx].y == null || l.y <= starts[startIdx].y + 1)))) {
        startIdx++;
        forced = true;
      }
      if (forced) {
        flush();
        blocks.push(...deferred);
        deferred = [];
      }
      const kind = l.tableId ? "table" : l.headingLevel ? "heading" : l.size >= 1.1 * stats.bodySize && !l.mono ? "large" : l.size < 0.85 * stats.bodySize ? "small" : "body";
      const isFootnote = fnStart >= 0 && i >= fnStart && kind === "small";

      // a contents entry is a block of its own, whatever its spacing says
      let startNew = !cur || forced || l.figureBreak || ((l.captionId || cur.captionId) && l.captionId !== cur.captionId) || l.contentsRow || cur.lastLine.contentsRow || (prev && prev.column !== l.column);
      if (!startNew && (kind === "table" || cur.kind === "table")) startNew = kind !== cur.kind || cur.tableId !== l.tableId;
      if (!startNew && kind !== "table" && !l.captionId) {
        const headingLike = (k) => k === "heading" || k === "large";
        if (headingLike(kind) && headingLike(cur.kind) && isLabel(cur.text) && prev && prev.y - l.y < 4.5 * Math.max(prev.size, l.size)) {
          startNew = false; // "CHAPTER 3" + "THEY DON'T SHY AWAY FROM CHANGE" -> one heading
          if (kind === "heading") Object.assign(cur, { kind, headingId: l.headingId, level: Math.min(cur.level ?? 3, l.headingLevel) });
        } else if (kind === "heading") startNew = cur.kind !== "heading" || cur.headingId !== l.headingId;
        else if (cur.kind === "heading") {
          // a wrapped heading line the title match did not cover ("CHAPTER IX. THE WORLD OF" / "UNIVERSALS")
          startNew = !(kind === "large" && prev && Math.abs(l.size - prev.size) <= 0.06 * prev.size && prev.y - l.y <= 2 * l.size);
        }
        else if (l.mono !== cur.mono) {
          // A short inline URL/identifier may wrap onto a monospace line. A listing after
          // a list item, a blank gap, or a line containing code syntax starts its own block.
          const inlineUrl = /^(?:https?:\/\/|www\.)\S+$/i.test(l.text);
          const codeSyntax = /[{};=]|^\s*(?:[$>] |# |\/\/)/.test(l.text);
          const close = prev && prev.y - l.y >= 0 && prev.y - l.y < 1.6 * (pg.leading ?? stats.leading);
          startNew = !(l.mono && close && !TERMINAL_RE.test(prev.text) &&
            !BULLET_RE.test(cur.text) && !BARE_MARKER_RE.test(cur.text) &&
            (inlineUrl || !codeSyntax) && l.text.split(" ").length <= 3 && cur.kind === "body");
        }
        else if (kind !== cur.kind) {
          // body <-> small (small caps, a smaller inline run): continue a sentence that obviously runs on
          const width = pg.rightEdge - pg.leftEdge;
          const runOn =
            prev &&
            (kind === "body" || kind === "small") &&
            (cur.kind === "body" || cur.kind === "small") &&
            !TERMINAL_RE.test(prev.text) &&
            prev.x - pg.leftEdge < 2 * prev.size && // prose line, not a centred subheading
            prev.x2 - pg.leftEdge > 0.6 * width &&
            prev.y - l.y < 1.6 * (pg.leading ?? stats.leading);
          startNew = !runOn;
          if (runOn && kind === "body") Object.assign(cur, { kind: "body", size: l.size });
        }
        else if (kind === "large") startNew = !prev || prev.y - l.y > 2.6 * l.size || Math.abs(l.size - cur.size) > 0.08 * cur.size;
        else if (!prev) startNew = !continuesAcrossPage(cur, l, pg, stats);
        else startNew = paragraphBreak(prev, l, layout, stats, cur);
      }
      if (isFootnote) {
        // hold footnotes so a body paragraph that continues on the next page is not cut in two
        const last = deferred.at(-1);
        if (last && last.page === pg.num && !paragraphBreak(lines[i - 1], l, pg, stats)) last.text = joinLines(last.text, l.text, lex);
        else deferred.push({ kind: "small", text: l.text, page: pg.num, y: l.y, size: l.size, mono: l.mono, lastLine: l });
        continue;
      }
      if (startNew) {
        if (cur) blocks.push(cur);
        cur = { kind, text: l.text, tableId: l.tableId, captionId: l.captionId, format: l.format, page: pg.num, y: l.y, size: l.size, mono: l.mono, headingId: l.headingId, level: l.headingLevel ?? (kind === "large" ? tierLevel(l.size) : undefined), lastLine: l, nLines: 1, firstX: l.x, lines: [l] };
        if (deferred.length && deferred[0].page !== pg.num) {
          blocks.push(...deferred);
          deferred = [];
        }
      } else {
        cur.text = cur.mono ? `${cur.text}\n${l.text}` : joinLines(cur.text, l.text, lex);
        cur.lastLine = l;
        cur.lines.push(l);
        cur.nLines++;
      }
    }
  }
  flush();
  blocks.push(...deferred);
  promoteStandaloneHeadings(blocks, stats);
  return blocks;
}

/**
 * Body-size subheadings (bold or centred in the original) have no size signal. Promote a short,
 * standalone, unpunctuated line that introduces a real paragraph.
 */
function promoteStandaloneHeadings(blocks, stats) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const next = blocks[i + 1];
    const prev = blocks[i - 1];
    if ((b.kind !== "body" && b.kind !== "small") || b.format === "caption" || b.mono || !b.lines || b.nLines > 2 || !next) continue;
    const text = b.text.trim();
    if (text.length > 60 || !/^\p{Lu}/u.test(text) || /[.,;:]$/.test(text) || /\d/.test(text)) continue;
    if (/^[\u2014\u2013-]/.test(next.text) || next.kind === "heading" || next.kind === "large") continue;
    const centred = b.lines.every((l) => {
      const mid = ((l.pageLeft ?? 0) + (l.pageRight ?? 0)) / 2;
      return Math.abs((l.x + l.x2) / 2 - mid) < 1.5 * l.size && l.x - (l.pageLeft ?? 0) > 2 * l.size;
    });
    const leftAligned = b.nLines === 1 && Math.abs(b.lines[0].x - (b.lines[0].pageLeft ?? 0)) < 0.5 * b.size;
    if (centred) {
      if (/[!?]$/.test(text) && text.length > 30) continue; // a centred quotation, not a title
    } else if (leftAligned) {
      if (/[!?"\u201D]$/.test(text) || text.split(" ").length > 8) continue;
      if (next.text.length < 120 || !/^[\p{Lu}\u201C"]/u.test(next.text)) continue; // must introduce a real paragraph
      if (prev && prev.kind !== "heading" && prev.kind !== "large" && !TERMINAL_RE.test(prev.text)) continue;
    } else continue;
    b.kind = "heading";
    b.level = b.size >= stats.bodySize * 0.97 && centred ? 2 : 3;
  }
}

function paragraphBreak(prev, l, pg, stats, cur = null) {
  const gap = prev.y - l.y;
  const lead = (pg.leading ?? stats.leading) * (l.size / stats.bodySize);
  if (gap < 0) return true;
  // Each printed list marker begins a separate item, even without terminal punctuation.
  if (!l.mono && (BULLET_RE.test(l.text) || BARE_MARKER_RE.test(l.text))) return true;
  // a sentence that obviously runs on ("in the market" / "right now") is never split by spacing or indent
  if (!TERMINAL_RE.test(prev.text) && /^\p{Ll}/u.test(l.text) && gap < 2.5 * lead) return false;
  if (gap - lead > 0.3 * l.size) return true;
  if (l.mono) return false; // code listings: only vertical gaps separate them
  const indentNow = l.x - prev.x;
  // hanging indent: wrapped lines of a bullet/numbered item sit to the right of the bullet
  const hanging = cur && BULLET_RE.test(cur.text) && !BULLET_RE.test(l.text) && l.x > cur.firstX + 0.3 * l.size;
  // centred text (epigraphs, subtitles): ragged on both sides, so x shifts mean nothing
  const centred =
    l.x - pg.leftEdge > 1.5 * l.size && Math.abs((prev.x + prev.x2) / 2 - (l.x + l.x2) / 2) < 0.8 * l.size && pg.rightEdge - l.x2 > 1.5 * l.size;
  // a first-line indent only starts a paragraph if the previous one plausibly ended
  // (bibliographies and wrapped list items use hanging indents after an unfinished line)
  const prevEnded = TERMINAL_RE.test(prev.text) || pg.rightEdge - prev.x2 > Math.max(3 * l.size, 0.12 * (pg.rightEdge - pg.leftEdge));
  if (stats.indentStyle && !hanging && !centred && prevEnded && indentNow > 0.6 * l.size && indentNow < 6 * l.size) return true;
  if (BARE_MARKER_RE.test(prev.text)) return false; // "3." on its own line, item text below it
  if ((BULLET_RE.test(l.text) || BARE_MARKER_RE.test(l.text)) && TERMINAL_RE.test(prev.text)) return true;
  if (/\s\d{1,4}$/.test(prev.text) && /\s\d{1,4}$/.test(l.text) && pg.rightEdge - prev.x2 > 2 * l.size) return true; // table of contents rows
  // lists and verse: a line ending well short of the measure, followed by a capitalised line
  if (prev.x2 - pg.leftEdge < 0.6 * (pg.rightEdge - pg.leftEdge) && /^\p{Lu}/u.test(l.text) && !/[,;\-\u2013\u2014]$/.test(prev.text)) return true;
  const short = pg.rightEdge - prev.x2 > Math.max(3 * l.size, 0.12 * (pg.rightEdge - pg.leftEdge));
  if (stats.justified && short && TERMINAL_RE.test(prev.text)) return true;
  return false;
}

function continuesAcrossPage(cur, l, pg, stats) {
  if (cur.kind !== "body" && cur.kind !== "small") return false;
  if (l.size < 0.85 * cur.size || l.size > 1.15 * cur.size) return false;
  // a sentence cut mid-way that resumes in lowercase is the strongest signal there is
  if (!TERMINAL_RE.test(cur.text) && /^\p{Ll}/u.test(l.text)) return true;
  if (BULLET_RE.test(l.text) || BARE_MARKER_RE.test(l.text)) return false;
  // indentation relative to each page's own text edge (odd/even pages have different margins)
  const prev = cur.lastLine;
  const prevRel = prev.x - (prev.pageLeft ?? pg.leftEdge);
  const rel = l.x - pg.leftEdge;
  const hanging = BULLET_RE.test(cur.text) && rel > 0.3 * l.size;
  if (stats.indentStyle && !hanging && rel > 0.6 * l.size && rel < 6 * l.size && rel - prevRel > 0.3 * l.size) return false;
  if (!TERMINAL_RE.test(cur.text)) return true;
  if (stats.justified && prev.pageRight != null && prev.pageRight - prev.x2 < 0.8 * prev.size) return true;
  return stats.indentStyle; // indent-style books: an unindented first line continues the paragraph
}

// ---------------------------------------------------------------------------------------------
// Stage 8: assemble chapters

function assemble(blocks, starts, numPages) {
  const chapters = starts.map((s) => ({ title: s.title, startPage: s.page, y: s.y, isPart: !!s.isPart, blocks: [] }));
  let ci = -1;
  const pre = { title: "Front Matter", untitled: true, startPage: 1, y: null, blocks: [] };
  for (const b of blocks) {
    while (ci + 1 < chapters.length && (chapters[ci + 1].startPage < b.page || (chapters[ci + 1].startPage === b.page && (chapters[ci + 1].y == null || b.y <= chapters[ci + 1].y + 1)))) ci++;
    (ci < 0 ? pre : chapters[ci]).blocks.push(b);
  }
  const list = separateMatter(pre.blocks.length ? [pre, ...chapters] : chapters);
  const chars = (c) => c.blocks.reduce((n, b) => n + b.text.length, 0);

  // tiny chapters (part title pages, book-title pages) merge forward into the next chapter of the same kind
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const next = list[i + 1];
    if (next && i > 0 && chars(c) < 400 && next.kind === c.kind) {
      next.blocks = [...c.blocks, ...next.blocks];
      next.startPage = Math.min(c.startPage, next.startPage);
      next.y = c.y;
      continue;
    }
    if (!c.blocks.length && next) continue;
    out.push(c);
  }
  // page ranges
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    const next = out[i + 1];
    const lastBlockPage = c.blocks.at(-1)?.page ?? c.startPage;
    c.endPage = next ? Math.max(c.startPage, lastBlockPage, next.startPage - 1) : numPages;
    if (next && c.endPage > next.startPage) c.endPage = next.startPage;
  }
  return out.filter((c) => c.blocks.length);
}

/** Project source glyph formatting onto the finalized selectable text. Repairs remove only
 * whitespace and line-end hyphens, so ordered glyphs retain their exact final character offsets. */
function typography(block, text, stats) {
  const parts = (block.lines ?? []).flatMap((l) => l.parts ?? []);
  if (!parts.length) return {};
  const runs = [];
  let cursor = 0;
  for (const part of parts) {
    for (const char of part.text.replace(/\u00AD/g, "")) {
      if (/\s/u.test(char)) continue;
      while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor++;
      if (char !== text.slice(cursor, cursor + char.length)) {
        // Dehyphenation and letter spacing leave the next source glyph at the same offset.
        if (char === "-") continue;
        const found = text.indexOf(char, cursor);
        if (found < 0 || found - cursor > 4) continue;
        cursor = found;
      }
      const style = part.style ?? { fontFamily: block.mono ? "monospace" : "sans-serif", bold: false, italic: false };
      const prev = runs.at(-1);
      if (prev && prev.bold === style.bold && prev.italic === style.italic && prev.fontFamily === style.fontFamily && /^\s*$/.test(text.slice(prev.end, cursor))) prev.end = cursor + char.length;
      else runs.push({ start: cursor, end: cursor + char.length, ...style });
      cursor += char.length;
    }
  }
  const familyWeights = new Map();
  for (const run of runs) familyWeights.set(run.fontFamily, (familyWeights.get(run.fontFamily) ?? 0) + run.end - run.start);
  const fontFamily = [...familyWeights].sort((a, b) => b[1] - a[1])[0]?.[0];
  const lines = block.lines ?? [];
  const alignments = lines.map((l) => {
    const left = l.layoutLeft ?? l.pageLeft ?? l.view?.[0] ?? 0;
    const right = l.layoutRight ?? l.pageRight ?? l.view?.[2] ?? l.x2;
    const midpoint = l.column != null ? (left + right) / 2 : ((l.view?.[0] ?? left) + (l.view?.[2] ?? right)) / 2;
    if (Math.abs((l.x + l.x2) / 2 - midpoint) < 1.5 * l.size && l.x2 - l.x < 0.7 * ((l.view?.[2] ?? right) - (l.view?.[0] ?? left))) return "center";
    if (l.x - left > 2 * l.size && Math.abs(l.x2 - right) < 0.5 * l.size && l.x2 - l.x < 0.8 * (right - left)) return "right";
    return "left";
  });
  let align = alignments.every((a) => a === "center") ? "center" : alignments.every((a) => a === "right") ? "right" : "left";
  if (align === "left" && lines.length > 1 && stats.justified && lines.slice(0, -1).every((l) => (l.pageRight ?? l.x2) - l.x2 < 0.8 * l.size)) align = "justify";
  const style = { align, fontFamily, fontSize: Math.round(block.size / stats.bodySize * 100) / 100 };
  if (runs.length && runs.every((r) => r.bold)) style.bold = true;
  if (runs.length && runs.every((r) => r.italic)) style.italic = true;
  return { style, runs };
}

/** Preserve code line breaks and reconstruct leading spaces from monospace glyph positions. */
function codeText(block) {
  if (!block.lines?.length) return block.text.replace(/\u00AD/g, "").trimEnd();
  const left = Math.min(...block.lines.map((l) => l.x));
  return block.lines.map((l) => {
    const indent = Math.max(0, Math.min(80, Math.round((l.x - left) / (0.6 * l.size))));
    return " ".repeat(indent) + l.text.replace(/\u00AD/g, "").trimEnd();
  }).join("\n");
}

function toBook(chapters, meta, stats) {
  return {
    title: meta.title,
    author: meta.author,
    pageCount: meta.pageCount,
    chapters: chapters.map((c, ci) => {
      const id = `c${ci + 1}`;
      let bi = 0;
      return {
        id,
        title: finalText(c.title).slice(0, 200) || `Section ${ci + 1}`,
        kind: c.kind,
        startPage: c.startPage,
        endPage: c.endPage,
        blocks: c.blocks
          .map((b) => {
            if (b.kind === "image") return { id: `${id}-b${++bi}`, type: "image", text: "", page: b.page, image: b.image };
            if (b.kind === "table") {
              const rows = b.lines.map((l) => l.cells.map((c) => c.text));
              const text = rows.map((row) => row.join("\t")).join("\n");
              return { id: `${id}-b${++bi}`, type: "table", text, page: b.page, rows, ...typography(b, text, stats) };
            }
            const isCode = b.mono && (b.nLines > 1 || /[{};=]|^\s*(?:[$>] |# |\/\/)/.test(b.text));
            const text = isCode ? codeText(b) : finalText(b.text);
            if (!text) return null;
            const sentenceLike = BULLET_RE.test(text) || (text.length > 80 && /[.!?]["\u201D\u2019]?$/.test(text));
            const isHeading = (b.kind === "heading" || (b.kind === "large" && !sentenceLike)) && text.length <= 200 && b.nLines <= 4;
            /** @type {Block} */
            const block = { id: `${id}-b${++bi}`, type: isCode ? "code" : isHeading ? "heading" : "paragraph", text, page: b.page, ...typography(b, text, stats) };
            if (b.format) block.format = b.format;
            else if (!isHeading && !isCode && BULLET_RE.test(text)) block.format = "list-item";
            if (isHeading) block.level = /** @type {1|2|3} */ (Math.min(3, Math.max(1, b.level ?? 2)));
            return block;
          })
          .filter(Boolean),
      };
    }),
    warnings: meta.warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestration

/**
 * Parse a book PDF into chapters and reflowable blocks.
 * @param {string} filePath
 * @param {ParseOptions} [options]
 * @returns {Promise<Book>}
 * @throws {PdfParseError}
 */
export async function parsePdf(filePath, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const warnings = [];
  const ex = await extract(filePath, o, warnings);
  const { pages, numPages } = ex;

  if (numPages === 0) throw new PdfParseError("empty", "The PDF has no pages.");
  // scanned / garbled detection before any layout work
  const perPage = pages.map((p) => p.items.reduce((n, it) => n + it.s.replace(/\s/g, "").length, 0));
  const textPages = perPage.filter((n) => n >= 40).length;
  const totalChars = perPage.reduce((a, b) => a + b, 0);
  if (textPages < Math.max(1, 0.15 * numPages)) {
    throw new PdfParseError(
      "scanned",
      `This PDF has no usable text layer: only ${textPages} of ${numPages} pages contain text (${(totalChars / numPages).toFixed(1)} characters per page on average). Local OCR could not recover enough readable text. Install Tesseract and the book’s language data (DEEPREAD_OCR_LANG), or import a PDF with a readable text layer.`,
    );
  }
  const allText = pages.map((p) => p.items.map((it) => it.s).join("")).join("");
  if (textQuality(allText).garbled) {
    throw new PdfParseError("garbled", "This PDF's text layer is garbled and local OCR could not recover it. Install Tesseract and the book’s language data (DEEPREAD_OCR_LANG), or import a PDF with a readable text layer.");
  }
  const missingPages = pages.filter((pg, index) => perPage[index] < 40 && !pg.figures?.length && !pg.failed).length;
  if (missingPages > 0.25 * numPages) warnings.push(`${missingPages} of ${numPages} pages have little or no text and no retained figures.`);

  for (const pg of pages) pg.lines = buildLines(pg);
  const hf = removeHeadersFooters(pages, warnings);
  if (hf.removed) warnings.push(`Removed ${hf.removed} running header/footer/page-number lines (${hf.patterns.length} patterns).`);
  repairFakeSpaces(pages, warnings);
  const stats = bookStats(pages);
  for (const pg of pages) for (const l of pg.lines) Object.assign(l, { pageLeft: l.layoutLeft ?? pg.leftEdge, pageRight: l.layoutRight ?? pg.rightEdge });
  const lex = buildLexicon(pages);

  let structure = o.useOutline && ex.outline.length ? structureFromOutline(ex.outline, pages, stats, numPages, warnings) : null;
  if (o.useOutline && !ex.outline.length) warnings.push("The PDF has no outline (bookmarks).");
  if (!structure) structure = structureFromText(pages, stats, numPages, warnings);

  applyMarks(structure.marks, pages, stats);
  // chapter start positions: prefer the matched title line over the raw destination y
  const starts = structure.chapters
    .map((c) => {
      const mark = structure.marks.find((m) => m.level === 1 && m.page === c.page && m.title === c.title && m.matchY != null);
      const y = mark ? Math.max(mark.matchY, c.y ?? -Infinity) : c.y != null ? c.y + 2 : null;
      return { ...c, y: y != null && Number.isFinite(y) ? y : null };
    })
    .sort((a, b) => a.page - b.page || (b.y ?? Infinity) - (a.y ?? Infinity));
  pullBackTitlePages(starts, pages, stats);
  markContentsRows(pages, starts, stats);

  prepareFigureBreaks(pages, stats);
  const blocks = insertFigures(buildBlocks(pages, stats, starts, lex), pages);
  const chapters = assemble(blocks, starts, numPages);
  const keptAlnum = chapters.reduce((n, c) => n + c.blocks.reduce((m, b) => m + alnum(finalText(b.text)), 0), 0);
  checkCoverage(pages, keptAlnum, warnings);

  const title =
    finalText(String(ex.info?.Title ?? ""))
      .replace(/^microsoft word\s*-\s*/i, "")
      .replace(/\s+\|\s+[^|]{2,40}$/, "") // "The Problems of Philosophy | Project Gutenberg"
      .replace(/\s*[-\u2013|(]\s*[\w.-]+\.(?:com|org|net|io|ru)\s*\)?$/i, "") || // "... - PDFDrive.com"
    basename(filePath).replace(/\.pdf$/i, "").replace(/[_]+/g, " ");
  const author = finalText(String(ex.info?.Author ?? "")) || null;
  return toBook(chapters, { title, author, pageCount: numPages, warnings }, stats);
}

/**
 * Text-coverage self-check: letters and digits that reached the blocks vs. those in the PDF's text
 * layer, minus what was dropped on purpose (running heads, page numbers, footnote markers, duplicate
 * overprints). Counting characters rather than words keeps the check immune to de-hyphenation and
 * fake-space repair, which change word boundaries but not letters. Below 97%, warn and name the pages.
 */
function checkCoverage(pages, keptAlnum, warnings) {
  const expected = pages.reduce((n, pg) => n + pg.rawAlnum - pg.hfAlnum - pg.droppedAlnum, 0);
  if (expected <= 0) return;
  const ratio = keptAlnum / expected;
  if (ratio >= 0.97) return;
  // localise: per page, what the emitted lines carried vs. what the page's text layer had
  const lossy = [];
  for (const pg of pages) {
    const want = pg.rawAlnum - pg.hfAlnum - pg.droppedAlnum;
    const got = pg.lines.reduce((n, l) => n + alnum(l.text), 0);
    if (want - got >= 40 && got < 0.85 * want) lossy.push(pg.num);
  }
  const ranges = [];
  for (const p of lossy) {
    const last = ranges.at(-1);
    if (last && last[1] === p - 1) last[1] = p;
    else ranges.push([p, p]);
  }
  const where = ranges.length
    ? `text was lost on page${lossy.length > 1 ? "s" : ""} ${ranges.slice(0, 12).map(([a, b]) => (a === b ? `${a}` : `${a}\u2013${b}`)).join(", ")}${ranges.length > 12 ? ", ..." : ""}`
    : "the loss is spread across the book";
  warnings.push(
    `Text coverage check: only ${(ratio * 100).toFixed(1)}% of the text layer (${keptAlnum.toLocaleString("en-US")} of ${expected.toLocaleString("en-US")} letters/digits) made it into the book; ${where}.`,
  );
}

/** A chapter whose title sits at the top of page P often has a decorative opener on P-1
 *  ("THE FIRST PRACTICE", "Part One"). Pull the start back over such heading-only pages. */
function pullBackTitlePages(starts, pages, stats) {
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const prevStart = starts[i - 1];
    const pg = pages[s.page - 1];
    if (!pg || s.page <= 1) continue;
    const before = pg.lines.filter((l) => s.y == null || l.y > s.y + 1);
    if (before.some((l) => stats.isBody(l))) continue; // title not at page top
    const prev = pages[s.page - 2];
    if (!prev || (prevStart && prevStart.page >= prev.num)) continue;
    if (prev.lines.length && prev.lines.length <= 4 && prev.lines.every((l) => l.size >= 1.1 * stats.bodySize)) {
      s.page = prev.num;
      s.y = null;
    }
  }
}

/**
 * A contents page lists the chapters, one per line. Without page numbers its rows look like the lines of a
 * paragraph and run together ("CHAPTER VII. ... CHAPTER VIII. ..."), so a body-type line naming a chapter the
 * parser found is marked as an entry of its own. One such line can be a cross-reference; three on a page are a list.
 */
function markContentsRows(pages, starts, stats) {
  const titles = new Set(starts.map((s) => normKey(s.title)).filter((k) => k.length >= 3));
  for (const pg of pages) {
    const rows = pg.lines.filter((l) => !l.headingLevel && l.size < 1.1 * stats.bodySize && titles.has(normKey(l.text)));
    if (new Set(rows.map((l) => normKey(l.text))).size < 3) continue;
    for (const l of rows) {
      l.contentsRow = true;
      delete l.tableId;
      // an unnumbered entry keeps the link text of its empty number column: ". PREFACE"
      l.text = l.text.replace(/^\.+\s+/, "");
    }
  }
}

/**
 * Same as parsePdf but runs in a worker thread that is terminated after `hardTimeoutMs`.
 * Use this in the server: a synchronous infinite loop inside pdf.js cannot be interrupted by
 * promise timeouts, but it can be by killing the thread.
 * @param {string} filePath
 * @param {ParseOptions} [options]
 * @returns {Promise<Book>}
 */
export function parsePdfIsolated(filePath, options = {}) {
  const o = { ...DEFAULTS, ...options };
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL(import.meta.url), { workerData: { deepreadParse: true, filePath, options: o } });
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new PdfParseError("timeout", `Parsing did not finish within ${o.hardTimeoutMs} ms.`)), o.hardTimeoutMs);
    worker.once("message", (m) => (m.ok ? done(resolve, m.book) : done(reject, new PdfParseError(m.error.error, m.error.message))));
    worker.once("error", (e) => done(reject, new PdfParseError("invalid_pdf", `Parser crashed: ${e.message}`)));
    worker.once("exit", (code) => done(reject, new PdfParseError("invalid_pdf", `Parser exited unexpectedly (code ${code}).`)));
  });
}

function errorJSON(e) {
  return e instanceof PdfParseError ? e.toJSON() : { error: "invalid_pdf", message: String(e?.message ?? e) };
}

if (!isMainThread && workerData?.deepreadParse) {
  parsePdf(workerData.filePath, workerData.options).then(
    (book) => parentPort.postMessage({ ok: true, book }),
    (e) => parentPort.postMessage({ ok: false, error: errorJSON(e) }),
  );
}

// ---------------------------------------------------------------------------------------------
// CLI

if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    process.stderr.write("usage: node parsePdf.mjs <file.pdf> [--isolated] [--no-outline] [--compact]\n");
    process.exit(64);
  }
  const opts = { useOutline: !args.includes("--no-outline") };
  const run = args.includes("--isolated") ? parsePdfIsolated : parsePdf;
  run(file, opts).then(
    (book) => process.stdout.write(`${JSON.stringify(book, null, args.includes("--compact") ? 0 : 2)}\n`),
    (e) => {
      process.stdout.write(`${JSON.stringify(errorJSON(e))}\n`);
      process.exitCode = 2;
    },
  );
}
