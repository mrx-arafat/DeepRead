import { describe, expect, it } from "vitest";
import { titleFromFileName } from "./upload-name.ts";

describe("titleFromFileName", () => {
  it("should turn a file name into a readable title when it uses underscores and a .pdf ending", () => {
    expect(titleFromFileName("The_Problems_of__Philosophy.PDF")).toBe("The Problems of Philosophy");
  });

  it("should keep the hyphens of a name that already has spaces and open the ones of a name that has none", () => {
    expect(titleFromFileName("Russell - Problems of Philosophy (1912).pdf")).toBe("Russell - Problems of Philosophy (1912)");
    expect(titleFromFileName("problems-of-philosophy.pdf")).toBe("problems of philosophy");
  });

  it("should drop the folder when the browser or a client sends a path", () => {
    expect(titleFromFileName("C:\\Users\\me\\Books\\big.pdf")).toBe("big");
    expect(titleFromFileName("../../etc/shelf/big.pdf")).toBe("big");
  });

  it("should fall back to a plain name when nothing readable is left", () => {
    expect(titleFromFileName(".pdf")).toBe("Untitled book");
    expect(titleFromFileName("  \u0000 ")).toBe("Untitled book");
  });

  it("should stay within what a file system and the title field accept when the name is very long", () => {
    expect(titleFromFileName(`${"a".repeat(500)}.pdf`)).toHaveLength(200);
    const bangla = titleFromFileName(`${"বই".repeat(200)}.pdf`);
    expect(Buffer.byteLength(bangla)).toBeLessThanOrEqual(240);
    expect(bangla.length).toBeGreaterThan(60);
  });
});
