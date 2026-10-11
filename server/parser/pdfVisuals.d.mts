export interface CompactOcrItem {
  s: string;
  x: number;
  y: number;
  w: number;
  size: number;
}
export interface FigureRegion {
  bounds: number[];
  kind: "raster" | "vector";
}
export interface PdfFigure {
  scanned: boolean;
  type: "image";
  kind: "image";
  text: "";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  image: {
    src: string;
    width: number;
    height: number;
    alt: string;
    ocrText?: string;
  };
}
export interface OcrOptions {
  timeoutMs?: number;
  language?: string;
  executable?: string;
}
export interface VisualOptions {
  pageNumber?: number;
  textItems?: CompactOcrItem[];
  scanned?: boolean;
  timeoutMs?: number;
  ocrTimeoutMs?: number;
  maxFigures?: number;
  ocrLanguage?: string;
  ocr?: boolean;
  images?: boolean;
  forceOcr?: boolean;
  totalBudgetMs?: number;
  ocrRunner?: (png: Buffer, options: OcrOptions) => Promise<string>;
}
export function detectFigureRegions(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  OPS: Record<string, number>,
  view: number[],
  textItems?: CompactOcrItem[],
  onLimit?: () => void,
): FigureRegion[];
export function ocrTsvItems(
  tsv: string,
  viewport: { convertToPdfPoint(x: number, y: number): number[] },
): CompactOcrItem[];
export function runLocalOcr(png: Buffer, options?: OcrOptions): Promise<string>;
export function extractPageVisuals(
  page: import("pdfjs-dist").PDFPageProxy,
  options?: VisualOptions,
): Promise<{
  figures: PdfFigure[];
  ocrItems: CompactOcrItem[];
  warnings: string[];
  ocrUsed: boolean;
}>;
