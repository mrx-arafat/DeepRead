import type { SectionKind } from "../../shared/types.ts";

/** A section while the parser assembles the book; `untitled` marks the text before the first chapter. */
export type MatterSection = {
  title: string;
  untitled?: boolean;
  kind?: SectionKind;
  startPage: number;
  y: number | null;
  blocks: { text: string; page: number; y: number }[];
};

/**
 * Cuts Project Gutenberg's header and licence off the book, marks every section front, body or back matter,
 * and folds the leading front matter into one section.
 */
export function separateMatter(sections: MatterSection[]): MatterSection[];
