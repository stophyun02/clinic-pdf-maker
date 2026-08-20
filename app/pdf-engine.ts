import { PDFDocument, rgb } from "pdf-lib";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type TextItemLike = { str: string; transform: number[] };

export type HanyoungSource = { passage: number; year: number; month: number; question: number };
export type HanyoungWorkbookAnalysis = WorkbookAnalysis & {
  sources: HanyoungSource[];
  c1ByPassage: Record<number, number>;
  c2ByPassage: Record<number, number>;
  c2YByPassage: Record<number, number>;
  answerC1ByPassage: Record<number, number>;
  answerC1YByPassage: Record<number, number>;
  answerC2ByPassage: Record<number, number>;
  answerC2YByPassage: Record<number, number>;
};

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

    const byLine = new Map<number, TextItemLike[]>();
    for (const item of items) {
      const y = Math.round(item.transform[5] * 2) / 2;
      const line = byLine.get(y) ?? [];
      line.push(item);
      byLine.set(y, line);
    }
    const lineTexts = [...byLine.values()].map((line) => compact(line.map((item) => item.str).join("")));
    const pageText = compact(items.map((item) => item.str).join(" "));
    const c1Header = lineTexts.some((line) => line === "c1" || line.startsWith("c1stepbystep"));
    const c2Header = lineTexts.some((line) => line === "c2" || line.startsWith("c2stepbystep"));
    const c1 = lineTexts.some((line) => line.includes("c1문장배열")) || (c1Header && pageText.includes("step01"));
    const c2 = lineTexts.some((line) => line.includes("c2영작배열")) || (c2Header && pageText.includes("step02"));
    let anchorY: number | null = null;
    for (const [y, line] of byLine) {
      const lineText = compact(line.map((item) => item.str).join(""));
      if (lineText.includes("아래주어진문장") && (lineText.includes("들어갈") || lineText.includes("이어질"))) {
        anchorY = y;
        break;
      }
    }
    if (anchorY == null && pageText.includes("아래주어진문장") && (pageText.includes("들어갈") || pageText.includes("이어질"))) {
      const fallback = items
        .filter((item) => compact(item.str).includes("아래") || compact(item.str).includes("주어진"))
        .sort((a, b) => a.transform[5] - b.transform[5])[0];
      if (fallback) anchorY = fallback.transform[5];
    }
    pages.push({ page: index, kind: c1 ? "C1" : c2 ? "C2" : null, anchorY });
  }

  return {
    pages,
    c1Groups: groups(pages.filter((page) => page.kind === "C1").map((page) => page.page)),
    c2Groups: groups(pages.filter((page) => page.kind === "C2").map((page) => page.page)),
  };
}

const sourcePattern = /(\d{1,2})\s*((?:20)?\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*번/;

export async function analyzeHanyoung(workbookBytes: Uint8Array, answerBytes: Uint8Array): Promise<HanyoungWorkbookAnalysis> {
  const base = await analyzeWorkbook(workbookBytes);
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const answer = await pdfjs.getDocument({ data: answerBytes.slice() }).promise;
  const found = new Map<number, HanyoungSource>();
  for (let pageNo = 1; pageNo <= answer.numPages && found.size < 20; pageNo += 1) {
    const page = await answer.getPage(pageNo); const content = await page.getTextContent();
    const text = content.items.filter((x): x is TextItemLike => "str" in x).map((x) => x.str).join(" ");
    for (const match of text.matchAll(new RegExp(sourcePattern.source, "g"))) {
      const passage = Number(match[1]);
      if (passage >= 2 && passage <= 40 && passage % 2 === 0 && !found.has(passage)) {
        let year = Number(match[2]); if (year < 100) year += 2000;
        found.set(passage, { passage, year, month: Number(match[3]), question: Number(match[4]) });
      }
    }
  }
  const detectPassages = async (pageNumbers: number[]) => {
    const doc = await pdfjs.getDocument({ data: workbookBytes.slice() }).promise;
    const result: Record<number, number> = {}; const yByPassage: Record<number, number> = {};
    for (const pageNo of pageNumbers) {
      const page = await doc.getPage(pageNo); const content = await page.getTextContent();
      const items = content.items.filter((x): x is TextItemLike => "str" in x);
      const candidates = items.filter((x) => /^\s*(?:[2-9]|[1-3]\d|40)\s*$/.test(x.str)).map((x) => ({ n: Number(x.str.trim()), y: x.transform[5] }));
      for (const item of candidates) if (item.n % 2 === 0 && found.has(item.n) && result[item.n] == null) { result[item.n] = pageNo; yByPassage[item.n] = item.y; }
    }
    return { pages: result, y: yByPassage };
  };
  const c1Pages = base.c1Groups.flat(); const c2Pages = base.c2Groups.flat();
  const [c1Detected, c2Detected] = await Promise.all([detectPassages(c1Pages), detectPassages(c2Pages)]);
  const answerPageData: { items: TextItemLike[]; text: string }[] = [];
  for (let pageNo = 1; pageNo <= answer.numPages; pageNo += 1) {
    const page = await answer.getPage(pageNo); const content = await page.getTextContent();
    const items = content.items.filter((x): x is TextItemLike => "str" in x);
    answerPageData.push({ items, text: compact(items.map((item) => item.str).join("")) });
  }
  const sectionRange = (heading: string, nextHeadings: string[]) => {
    const startIndex = answerPageData.findIndex((page) => page.text.includes(heading));
    if (startIndex < 0) return [];
    const relativeEnd = answerPageData.slice(startIndex).findIndex((page, offset) => offset > 0 && nextHeadings.some((next) => page.text.includes(next)));
    const endIndex = relativeEnd < 0 ? answerPageData.length - 1 : startIndex + relativeEnd;
    return Array.from({ length: endIndex - startIndex + 1 }, (_, index) => startIndex + index + 1);
  };
  const locateNeedleY = (items: TextItemLike[], needles: string[]) => {
    const pieces = items.map((item) => compact(item.str)); const joined = pieces.join("");
    const start = needles.map((needle) => joined.indexOf(needle)).find((index) => index >= 0);
    if (start == null) return null;
    let cursor = 0;
    for (let index = 0; index < pieces.length; index += 1) {
      const end = cursor + pieces[index].length;
      if (start >= cursor && start < end) return items[index].transform[5];
      cursor = end;
    }
    return null;
  };
  const mapAnswerPages = (pageNumbers: number[]) => {
    const result: Record<number, number> = {}; const yByPassage: Record<number, number> = {};
    for (const pageNo of pageNumbers) {
      const data = answerPageData[pageNo - 1];
      for (const mapping of found.values()) {
        if (result[mapping.passage] != null) continue;
        const yy = String(mapping.year).slice(-2);
        const needles = [compact(`${mapping.passage}${yy}년${mapping.month}월${mapping.question}번`), compact(`${mapping.passage}${mapping.year}년${mapping.month}월${mapping.question}번`)];
        const y = locateNeedleY(data.items, needles);
        if (y != null) { result[mapping.passage] = pageNo; yByPassage[mapping.passage] = y; }
      }
    }
    return { pages: result, y: yByPassage };
  };
  const answerC1Detected = mapAnswerPages(sectionRange("c1문장배열", ["c2빈칸어휘", "a1어법선택"]));
  const answerC2Detected = mapAnswerPages(sectionRange("c2영작배열", ["step03test", "s실전문제"]));
  return {
    ...base,
    sources: [...found.values()].sort((a, b) => a.passage - b.passage),
    c1ByPassage: c1Detected.pages,
    c2ByPassage: c2Detected.pages,
    c2YByPassage: c2Detected.y,
    answerC1ByPassage: answerC1Detected.pages,
    answerC1YByPassage: answerC1Detected.y,
    answerC2ByPassage: answerC2Detected.pages,
    answerC2YByPassage: answerC2Detected.y,
  };
}

function redactUnselectedAnswerBlocks(
  page: import("pdf-lib").PDFPage,
  pageNo: number,
  pageMap: Record<number, number>,
  yMap: Record<number, number>,
  selected: Set<number>,
) {
  const markers = Object.keys(pageMap)
    .map(Number)
    .filter((passage) => pageMap[passage] === pageNo && yMap[passage] != null)
    .map((passage) => ({ passage, y: yMap[passage] }))
    .sort((a, b) => b.y - a.y);
  const { width } = page.getSize(); const footerGuard = 38;
  markers.forEach((marker, index) => {
    if (selected.has(marker.passage)) return;
    const next = markers[index + 1]; const bottom = next ? next.y + 10 : footerGuard;
    const top = marker.y + 14;
    if (top > bottom) page.drawRectangle({ x: 0, y: bottom, width, height: top - bottom, color: rgb(1, 1, 1), borderWidth: 0 });
  });
}

async function findRetePage(bytes: Uint8Array, source: HanyoungSource) {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const compactCode = `${String(source.year).slice(-2)}${String(source.month).padStart(2, "0")}${String(source.question).padStart(2, "0")}`;
  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i); const content = await page.getTextContent();
    const text = content.items.filter((x): x is TextItemLike => "str" in x).map((x) => x.str).join(" ");
    pageTexts.push(text);
    if (text.replace(/\s+/g, "").includes(compactCode)) return i;
  }
  const exact = new RegExp(`(^|\\s)${source.question}(?=\\s|번|\\.|$)`);
  const fallback = pageTexts.findIndex((text) => exact.test(text));
  if (fallback >= 0) return fallback + 1;
  throw new Error(`리테에서 ${source.question}번 문제를 찾지 못했습니다.`);
}

export async function buildHanyoungPdf(
  workbookBytes: Uint8Array,
  analysis: HanyoungWorkbookAnalysis,
  passages: number[],
  reteLoader: (source: HanyoungSource, kind: "question" | "answer") => Promise<Uint8Array>,
  kind: "question" | "answer" = "question",
  workbookAnswerBytes?: Uint8Array,
) {
  const sourceBytes = kind === "question" ? workbookBytes : workbookAnswerBytes;
  if (!sourceBytes) throw new Error("워크북 정답지가 없습니다.");
  const source = await PDFDocument.load(sourceBytes.slice()); const output = await PDFDocument.create();
  const pageMap = kind === "question" ? analysis.c1ByPassage : analysis.answerC1ByPassage;
  const selected = new Set(passages);
  if (kind === "answer") {
    const missingC1 = passages.filter((passage) => analysis.answerC1ByPassage[passage] == null);
    const missingC2 = passages.filter((passage) => analysis.answerC2ByPassage[passage] == null);
    if (missingC1.length || missingC2.length) {
      const details = [missingC1.length ? `문장배열 ${missingC1.join(", ")}번` : "", missingC2.length ? `영작배열 ${missingC2.join(", ")}번` : ""].filter(Boolean).join(" / ");
      throw new Error(`워크북 정답지에서 선택 범위의 정답을 모두 찾지 못했습니다: ${details}`);
    }
  }
  const c1Pages = [...new Set(passages.map((n) => pageMap[n]).filter(Boolean))];
  if (kind === "question") {
    const missingAnchors = c1Pages.filter((pageNo) => analysis.pages[pageNo - 1]?.anchorY == null);
    if (missingAnchors.length) throw new Error(`하단 문제 위치를 안전하게 찾지 못한 문장배열 페이지: ${missingAnchors.join(", ")}`);
  }
  const copiedC1 = await output.copyPages(source, c1Pages.map((n) => n - 1)); copiedC1.forEach((p, index) => {
    output.addPage(p);
    if (kind === "question") {
      const original = c1Pages[index]; const anchorY = analysis.pages[original - 1]?.anchorY;
      if (anchorY != null) {
        const { width } = p.getSize(); const footerGuard = 62;
        p.drawRectangle({ x: 0, y: footerGuard, width, height: Math.max(0, anchorY + 24 - footerGuard), color: rgb(1, 1, 1), borderWidth: 0 });
      }
    } else redactUnselectedAnswerBlocks(p, c1Pages[index], analysis.answerC1ByPassage, analysis.answerC1YByPassage, selected);
  });
  for (const passage of passages) {
    const mapping = analysis.sources.find((x) => x.passage === passage); if (!mapping) throw new Error(`${passage}번 지문의 모의고사 출처를 찾지 못했습니다.`);
    const bytes = await reteLoader(mapping, kind); const rete = await PDFDocument.load(bytes.slice());
    const pageNo = await findRetePage(bytes, mapping); const [page] = await output.copyPages(rete, [pageNo - 1]); output.addPage(page);
  }
  const c2Map = kind === "question" ? analysis.c2ByPassage : analysis.answerC2ByPassage;
  const c2Pages = [...new Set(passages.map((n) => c2Map[n]).filter(Boolean))];
  const copiedC2 = await output.copyPages(source, c2Pages.map((n) => n - 1)); copiedC2.forEach((p, index) => {
    output.addPage(p);
    if (kind === "question") {
      const pageNo = c2Pages[index]; const omittedAfter = analysis.sources.filter((x) => x.passage > Math.max(...passages) && analysis.c2ByPassage[x.passage] === pageNo).sort((a, b) => a.passage - b.passage)[0];
      const y = omittedAfter && analysis.c2YByPassage[omittedAfter.passage];
      if (y) { const { width } = p.getSize(); p.drawRectangle({ x: 40, y: 62, width: width - 80, height: Math.max(0, y + 12 - 62), color: rgb(1, 1, 1), borderWidth: 0 }); }
    } else redactUnselectedAnswerBlocks(p, c2Pages[index], analysis.answerC2ByPassage, analysis.answerC2YByPassage, selected);
  });
  return output.save({ useObjectStreams: true });
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
  if (!c1) throw new Error("선택한 단원의 C1 문장배열 페이지 묶음을 찾을 수 없습니다.");
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
  if (c2) {
    const copiedC2 = await output.copyPages(source, c2.map((page) => page - 1));
    copiedC2.forEach((page) => output.addPage(page));
  }
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
  includeC2 = true,
) {
  const c1 = analysis.c1Sections[sectionIndex - 1];
  const c2 = analysis.c2Sections[sectionIndex - 1];
  if (!c1) throw new Error("선택한 단원의 C1 문장배열 정답 영역을 찾을 수 없습니다.");
  if (includeC2 && !c2) throw new Error("선택한 단원의 C2 영작배열 정답 영역을 찾을 수 없습니다.");
  const workbookAnswer = await PDFDocument.load(workbookAnswerBytes.slice());
  const reteAnswer = await PDFDocument.load(reteAnswerBytes.slice());
  const output = await PDFDocument.create();

  await appendAnswerSection(output, workbookAnswer, c1);
  const retePages = parsePageRanges(reteRange, reteAnswer.getPageCount());
  const copiedRete = await output.copyPages(reteAnswer, retePages.map((page) => page - 1));
  copiedRete.forEach((page) => output.addPage(page));
  if (includeC2 && c2) await appendAnswerSection(output, workbookAnswer, c2);
  return output.save({ useObjectStreams: true });
}
