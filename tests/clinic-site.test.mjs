import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("exposes one unified clinic workflow", async () => {
  const [page, maker] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/drive-maker.tsx", root), "utf8"),
  ]);
  assert.match(page, /클리닉 제작실/);
  assert.match(maker, /Drive 자료와 직접 올린 파일을 함께 확인합니다/);
  assert.match(maker, /보충 PDF 선택/);
  assert.match(maker, /학교와 범위를 직접 선택하세요/);
  assert.match(maker, /범위 종류/);
  assert.match(maker, /관리자용 Drive 분류 확인/);
});

test("stops unsafe Drive jobs instead of guessing", async () => {
  const [planner, maker] = await Promise.all([
    readFile(new URL("app/api/drive/plan/route.ts", root), "utf8"),
    readFile(new URL("app/drive-maker.tsx", root), "utf8"),
  ]);
  assert.match(planner, /"missing"/);
  assert.match(planner, /"ambiguous"/);
  assert.match(planner, /"review"/);
  assert.match(maker, /plan\.jobs\.filter\(jobCanBuild\)/);
  assert.match(maker, /rangeConfirmed/);
  assert.match(maker, /selectedCandidate\(job, "workbook"\)/);
  assert.match(maker, /자료현황\.csv/);
});

test("keeps the required clinic and booklet order", async () => {
  const maker = await readFile(new URL("app/drive-maker.tsx", root), "utf8");
  const front = maker.indexOf("copyPages(cover, [0])");
  const questions = maker.indexOf("copyPages(question");
  const answers = maker.indexOf("copyPages(answer");
  const backs = maker.indexOf("copyPages(cover, [1, 2])");
  assert.ok(front >= 0 && front < questions && questions < answers && answers < backs);
  assert.match(maker, /buildClinicPdf/);
  assert.match(maker, /buildClinicAnswerPdf/);
});

test("wires the four advanced safety engines into the unified workflow", async () => {
  const [maker, engine, ocr] = await Promise.all([
    readFile(new URL("app/drive-maker.tsx", root), "utf8"),
    readFile(new URL("app/pdf-engine.ts", root), "utf8"),
    readFile(new URL("app/api/ocr/route.ts", root), "utf8"),
  ]);
  assert.match(maker, /isHanyoungSpecial/);
  assert.match(maker, /buildHanyoungPdf/);
  assert.match(maker, /choice\.excludeFurther/);
  assert.match(engine, /c1Blocks/);
  assert.match(engine, /chooseBlocks/);
  assert.match(engine, /isFurtherReading/);
  assert.match(engine, /\/api\/ocr/);
  assert.match(ocr, /DOCUMENT_TEXT_DETECTION/);
});

test("lets users select a Drive workbook after choosing grade and school", async () => {
  const [maker, planner, materials] = await Promise.all([
    readFile(new URL("app/drive-maker.tsx", root), "utf8"),
    readFile(new URL("app/api/drive/plan/route.ts", root), "utf8"),
    readFile(new URL("app/api/drive/materials/route.ts", root), "utf8"),
  ]);
  assert.match(maker, /학년·학교로 찾기/);
  assert.match(maker, /selectedWorkbookId/);
  assert.match(maker, /selectedWorkbooks/);
  assert.match(planner, /선택한 교과서 파일이 현재 학교 자료실과 일치하지 않습니다/);
  assert.match(materials, /path\.includes\(schoolKey\)/);
  assert.match(materials, /!answer/);
});
