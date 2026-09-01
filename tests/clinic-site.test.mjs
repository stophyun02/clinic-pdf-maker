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
