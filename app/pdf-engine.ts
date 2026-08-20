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

export type AnswerSection = {
  startPage: number;
  startY: number;
  endPage: number;
  endY: number | null;
};

export type AnswerWorkbookAnalysis = {
  c1Sections: AnswerSection[];
  c2Sections: AnswerSection[];
};

type SectionHeading = { name: string; page: number; y: number };

const SECTION_NAMES = [
  "a1어휘선택", "a2본문ox", "b1본문정리", "b2내용종합",
  "c1문장배열", "c2빈칸어휘", "a1어법선택", "b1어법ox",
  "c1빈칸어법", "c2영작배열", "step03test", "s실전문제",
];

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

export async function analyzeAnswerWorkbook(bytes: Uint8Array): Promise<AnswerWorkbookAnalysis> {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const document = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const headings: SectionHeading[] = [];

  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is TextItemLike => "str" in item && "transform" in item);
    const byLine = new Map<number, TextItemLike[]>();
    for (const item of items) {
      const y = Math.round(item.transform[5] * 2) / 2;
      const line = byLine.get(y) ?? [];
      line.push(item);
      byLine.set(y, line);
    }
    for (const [y, line] of byLine) {
      const lineText = compact(line.map((item) => item.str).join(""));
      const name = SECTION_NAMES.find((candidate) => lineText === candidate || lineText.startsWith(candidate));
      if (name) headings.push({ name, page: index, y });
    }
  }

  headings.sort((a, b) => a.page - b.page || b.y - a.y);
  const toSection = (heading: SectionHeading, position: number): AnswerSection => {
    const next = headings[position + 1];
    return {
      startPage: heading.page,
      startY: heading.y,
      endPage: next ? (next.page === heading.page ? heading.page : next.page - 1) : document.numPages,
      endY: next?.page === heading.page ? next.y : null,
    };
  };
  const c1Sections: AnswerSection[] = [];
  const c2Sections: AnswerSection[] = [];
  headings.forEach((heading, index) => {
    if (heading.name === "c1문장배열") c1Sections.push(toSection(heading, index));
    if (heading.name === "c2영작배열") c2Sections.push(toSection(heading, index));
  });
  return { c1Sections, c2Sections };
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

async function appendAnswerSection(output: PDFDocument, source: PDFDocument, section: AnswerSection) {
  const indexes = Array.from({ length: section.endPage - section.startPage + 1 }, (_, index) => section.startPage - 1 + index);
  const pages = await output.copyPages(source, indexes);
  pages.forEach((page, index) => {
    output.addPage(page);
    const { width, height } = page.getSize();
    if (index === 0) {
      const y = Math.min(height, section.startY + 18);
      page.drawRectangle({ x: 0, y, width, height: height - y, color: rgb(1, 1, 1), borderWidth: 0 });
    }
    if (index === pages.length - 1 && section.endY != null) {
      const top = Math.min(height, section.endY + 18);
      page.drawRectangle({ x: 0, y: 0, width, height: top, color: rgb(1, 1, 1), borderWidth: 0 });
    }
  });
}

export async function buildClinicAnswerPdf(
  workbookAnswerBytes: Uint8Array,
  reteAnswerBytes: Uint8Array,
  analysis: AnswerWorkbookAnalysis,
  sectionIndex: number,
  reteRange: string,
) {
  const c1 = analysis.c1Sections[sectionIndex - 1];
  const c2 = analysis.c2Sections[sectionIndex - 1];
  if (!c1 || !c2) throw new Error("선택한 단원의 C1/C2 정답 영역을 찾을 수 없습니다.");
  const workbookAnswer = await PDFDocument.load(workbookAnswerBytes.slice());
  const reteAnswer = await PDFDocument.load(reteAnswerBytes.slice());
  const output = await PDFDocument.create();

  await appendAnswerSection(output, workbookAnswer, c1);
  const retePages = parsePageRanges(reteRange, reteAnswer.getPageCount());
  const copiedRete = await output.copyPages(reteAnswer, retePages.map((page) => page - 1));
  copiedRete.forEach((page) => output.addPage(page));
  await appendAnswerSection(output, workbookAnswer, c2);
  return output.save({ useObjectStreams: true });
}
