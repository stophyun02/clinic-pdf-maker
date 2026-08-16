import { PDFDocument, rgb } from "pdf-lib";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type TextItemLike = { str: string; transform: number[] };

export type WorkbookPage = {
  page: number;
  kind: "C1" | "C2" | null;
  anchorY: number | null;
};

export type WorkbookAnalysis = {
  pages: WorkbookPage[];
  c1Groups: number[][];
  c2Groups: number[][];
};

const compact = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");

const groups = (pages: number[]) => {
  const result: number[][] = [];
  for (const page of pages) {
    const last = result.at(-1);
    if (!last || page !== last.at(-1)! + 1) result.push([page]);
    else last.push(page);
  }
  return result;
};

export async function analyzeWorkbook(bytes: Uint8Array): Promise<WorkbookAnalysis> {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const document = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pages: WorkbookPage[] = [];

  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is TextItemLike => "str" in item && "transform" in item);
    const text = compact(items.map((item) => item.str).join(" "));
    const c1 = text.includes("c1문장배열") || (text.includes("c1") && text.includes("step01"));
    const c2 = text.includes("c2영작배열") || (text.includes("c2") && text.includes("step02"));

    const byLine = new Map<number, TextItemLike[]>();
    for (const item of items) {
      const y = Math.round(item.transform[5] * 2) / 2;
      const line = byLine.get(y) ?? [];
      line.push(item);
      byLine.set(y, line);
    }
    let anchorY: number | null = null;
    for (const [y, line] of byLine) {
      const lineText = compact(line.map((item) => item.str).join(""));
      if (lineText.includes("아래주어진문장") && (lineText.includes("들어갈위치") || lineText.includes("이어질문장"))) {
        anchorY = y;
        break;
      }
    }
    pages.push({ page: index, kind: c1 ? "C1" : c2 ? "C2" : null, anchorY });
  }

  return {
    pages,
    c1Groups: groups(pages.filter((page) => page.kind === "C1").map((page) => page.page)),
    c2Groups: groups(pages.filter((page) => page.kind === "C2").map((page) => page.page)),
  };
}

export function parsePageRanges(spec: string, pageCount: number) {
  const normalized = spec.trim().toLowerCase();
  if (["", "all", "전체", "*"].includes(normalized)) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const selected = new Set<number>();
  for (const raw of normalized.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (token.includes("-")) {
      const [start, end] = token.split("-").map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new Error(`잘못된 리테 범위: ${token}`);
      for (let page = start; page <= end; page += 1) selected.add(page);
    } else {
      const page = Number(token);
      if (!Number.isInteger(page)) throw new Error(`잘못된 리테 페이지: ${token}`);
      selected.add(page);
    }
  }
  const result = [...selected].sort((a, b) => a - b);
  const invalid = result.filter((page) => page < 1 || page > pageCount);
  if (invalid.length) throw new Error(`리테 PDF 범위를 벗어난 페이지: ${invalid.join(", ")}`);
  return result;
}

export async function buildClinicPdf(
  workbookBytes: Uint8Array,
  reteBytes: Uint8Array,
  analysis: WorkbookAnalysis,
  sectionIndex: number,
  reteRange: string,
) {
  const c1 = analysis.c1Groups[sectionIndex - 1];
  const c2 = analysis.c2Groups[sectionIndex - 1];
  if (!c1 || !c2) throw new Error("선택한 단원의 C1/C2 페이지 묶음을 찾을 수 없습니다.");
  const missing = c1.filter((page) => analysis.pages[page - 1]?.anchorY == null);
  if (missing.length) throw new Error(`하단 문제 위치를 안전하게 찾지 못한 워크북 페이지: ${missing.join(", ")}`);

  const source = await PDFDocument.load(workbookBytes.slice());
  const rete = await PDFDocument.load(reteBytes.slice());
  const output = await PDFDocument.create();

  for (const pageNumber of c1) {
    const [page] = await output.copyPages(source, [pageNumber - 1]);
    output.addPage(page);
    const { width } = page.getSize();
    const anchorY = analysis.pages[pageNumber - 1].anchorY!;
    const bottomGuard = 62;
    page.drawRectangle({
      x: 45,
      y: bottomGuard,
      width: width - 90,
      height: Math.max(0, anchorY + 20 - bottomGuard),
      color: rgb(1, 1, 1),
      borderWidth: 0,
    });
  }

  const retePages = parsePageRanges(reteRange, rete.getPageCount());
  const copiedRete = await output.copyPages(rete, retePages.map((page) => page - 1));
  copiedRete.forEach((page) => output.addPage(page));
  const copiedC2 = await output.copyPages(source, c2.map((page) => page - 1));
  copiedC2.forEach((page) => output.addPage(page));
  return output.save({ useObjectStreams: true });
}
