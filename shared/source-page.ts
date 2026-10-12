/** Selectable text positioned over an original page image; all lengths are fractions of image dimensions. */
export type SourcePageTextRun = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Font size as a fraction of image height. */
  fontSize: number;
  /** Clockwise degrees, matching CSS rotation around the run's top-left corner. */
  angle: number;
  dir: "ltr" | "rtl";
  hasEOL?: boolean;
  fontFamily?: "serif" | "sans-serif" | "monospace";
  source: "native" | "ocr";
};

export type SourcePageText = {
  width: number;
  height: number;
  runs: SourcePageTextRun[];
  warning?: string;
};
