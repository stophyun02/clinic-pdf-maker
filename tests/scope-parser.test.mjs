import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkbookScope } from "../app/scope-parser.js";

test("parses a whole textbook lesson", () => {
  assert.deepEqual(parseWorkbookScope("성덕고1: 2과 본문전체"), [
    { sectionIndex: 2, items: null },
  ]);
});

test("parses multiple textbook lessons with a partial second lesson", () => {
  assert.deepEqual(parseWorkbookScope("이대부고1: 공통영어2 YBM(김) 1과+2과 본문2"), [
    { sectionIndex: 1, items: null },
    { sectionIndex: 2, items: ["2"] },
  ]);
});

test("keeps nested passage labels and multiple lessons", () => {
  assert.deepEqual(parseWorkbookScope("성덕고2: 1과본문 4-2,5(두개)+2과본문"), [
    { sectionIndex: 1, items: ["4-2", "5"] },
    { sectionIndex: 2, items: null },
  ]);
});

test("does not mistake year, month, or chapter for requested mock questions", () => {
  assert.deepEqual(parseWorkbookScope("배재고2: 24년 9월 20~24,29~32번"), [
    { sectionIndex: 1, items: ["20", "21", "22", "23", "24", "29", "30", "31", "32"] },
  ]);
});

test("parses a supplement passage range", () => {
  assert.deepEqual(parseWorkbookScope("한영고1: 마더텅 11강 20~40번"), [
    { sectionIndex: 1, items: Array.from({ length: 21 }, (_, index) => String(index + 20)) },
  ]);
});

test("supports even-only ranges without school-specific rules", () => {
  assert.deepEqual(parseWorkbookScope("한영고1: 마더텅 11강 20~40번 (짝수 번호만)"), [
    { sectionIndex: 1, items: ["20", "22", "24", "26", "28", "30", "32", "34", "36", "38", "40"] },
  ]);
});

test("parses passage N까지", () => {
  assert.deepEqual(parseWorkbookScope("강동고2: YBM(박)1과 본문5까지"), [
    { sectionIndex: 1, items: ["1", "2", "3", "4", "5"] },
  ]);
});
