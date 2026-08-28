"use client";

import { useEffect, useMemo, useState } from "react";
import { PDFDocument } from "pdf-lib";
import { analyzeAnswerWorkbook, analyzeWorkbook, buildClinicAnswerPdf, buildClinicPdf } from "./pdf-engine";

type Role = "workbook" | "workbookAnswer" | "rete" | "reteAnswer" | "cover";
type Candidate = { id: string; name: string; path: string; size?: string; modifiedTime?: string };
type Job = {
  id: number;
  school: string;
  scope: string;
  status: "ready" | "missing" | "ambiguous" | "review";
  materials: Record<Role, Candidate[]>;
  missing: Role[];
  ambiguous: Role[];
  note: string;
};
type Plan = { scannedAt: string; fileCount: number; jobs: Job[] };

const roleName: Record<Role, string> = {
  workbook: "워크북",
  workbookAnswer: "워크북 정답",
  rete: "리테",
  reteAnswer: "리테 정답",
  cover: "표지",
};
const statusName = { ready: "생성 가능", missing: "자료 부족", ambiguous: "중복 후보", review: "범위 확인 필요" };
const defaultScope = `배재고1: 공통영어2 능률(오) 2과
상일여고2: 교과서 1과 6번 지문 + 올림포스 11강 1~4번 지문
한영고2: 24년 9월 모의고사 21~34번`;

async function loadPdf(candidate: Candidate) {
  const response = await fetch(`/api/drive/file?id=${encodeURIComponent(candidate.id)}`);
  if (!response.ok) throw new Error(`${candidate.name}을 불러오지 못했습니다.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function booklet(coverBytes: Uint8Array, questionBytes: Uint8Array, answerBytes: Uint8Array) {
  const [cover, question, answer] = await Promise.all([
    PDFDocument.load(coverBytes), PDFDocument.load(questionBytes), PDFDocument.load(answerBytes),
  ]);
  if (cover.getPageCount() < 3) throw new Error("표지는 앞표지·속지·뒤표지 3쪽이어야 합니다.");
  const output = await PDFDocument.create();
  const front = await output.copyPages(cover, [0]); front.forEach((page) => output.addPage(page));
  const questions = await output.copyPages(question, question.getPageIndices()); questions.forEach((page) => output.addPage(page));
  const answers = await output.copyPages(answer, answer.getPageIndices()); answers.forEach((page) => output.addPage(page));
  const backs = await output.copyPages(cover, [1, 2]); backs.forEach((page) => output.addPage(page));
  return output.save({ useObjectStreams: true });
}

function save(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a"); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

function csv(plan: Plan) {
  const rows = [["학교", "범위", "상태", "누락", "중복", "비고"], ...plan.jobs.map((job) => [
    job.school, job.scope, statusName[job.status], job.missing.map((role) => roleName[role]).join(" / "), job.ambiguous.map((role) => roleName[role]).join(" / "), job.note,
  ])];
  const content = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  save(new TextEncoder().encode(`\ufeff${content}`), "클리닉_자료현황.csv");
}

export default function DriveMaker() {
  const [scope, setScope] = useState(defaultScope);
  const [connection, setConnection] = useState<{ connected: boolean; fileCount: number; pdfCount?: number; error?: string } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const readyCount = useMemo(() => plan?.jobs.filter((job) => job.status === "ready").length ?? 0, [plan]);

  useEffect(() => {
    fetch("/api/drive/status").then((response) => response.json()).then(setConnection).catch(() => setConnection({ connected: false, fileCount: 0 }));
  }, []);

  async function inspect() {
    setBusy(true); setError(""); setMessage(""); setPlan(null); setProgress("Drive 자료를 학교별로 대조하고 있습니다…");
    try {
      const response = await fetch("/api/drive/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "자료 검색에 실패했습니다.");
      setPlan(payload); setMessage(`${payload.jobs.length}개 학교를 확인했습니다. 생성 가능 ${payload.jobs.filter((job: Job) => job.status === "ready").length}개입니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "자료 검색에 실패했습니다."); }
    finally { setBusy(false); setProgress(""); }
  }

  async function generateReady() {
    if (!plan || !readyCount) return;
    setBusy(true); setError(""); setMessage("");
    let completed = 0;
    const failures: string[] = [];
    for (const job of plan.jobs.filter((item) => item.status === "ready")) {
      try {
        setProgress(`${job.school} 자료를 검증하고 PDF를 만들고 있습니다…`);
        const one = (role: Role) => job.materials[role][0];
        const [wb, wa, rete, reteAnswer, cover] = await Promise.all([
          loadPdf(one("workbook")), loadPdf(one("workbookAnswer")), loadPdf(one("rete")), loadPdf(one("reteAnswer")), loadPdf(one("cover")),
        ]);
        const [analysis, answerAnalysis] = await Promise.all([analyzeWorkbook(wb), analyzeAnswerWorkbook(wa)]);
        const lesson = Number(job.scope.match(/(\d+)\s*과/)?.[1] ?? 1);
        if (!analysis.c1Groups.length || lesson > analysis.c1Groups.length) throw new Error("요청 단원과 워크북 구조가 일치하지 않습니다.");
        if (!answerAnalysis.c1Sections.length) throw new Error("워크북 정답에서 문장배열 정답을 찾지 못했습니다.");
        const hasC2 = analysis.c2Groups.length > 0;
        if (hasC2 && !answerAnalysis.c2Sections.length) throw new Error("영작배열 정답이 부족합니다.");
        const [question, answer] = await Promise.all([
          buildClinicPdf(wb, rete, analysis, lesson, "all"),
          buildClinicAnswerPdf(wa, reteAnswer, answerAnalysis, lesson, "all", hasC2),
        ]);
        const final = await booklet(cover, question, answer);
        save(final, `스텝인클리닉_${job.school}_${job.scope.replace(/[\\/:*?"<>|\s]+/g, "_")}.pdf`);
        completed += 1;
      } catch (reason) {
        failures.push(`${job.school}: ${reason instanceof Error ? reason.message : "생성 실패"}`);
      }
    }
    setBusy(false); setProgress("");
    if (failures.length) setError(`완료 ${completed}개 · 생성 중단 ${failures.length}개\n${failures.join("\n")}`);
    else setMessage(`${completed}개 학교의 완성본 다운로드를 시작했습니다.`);
  }

  return <>
    <section className="hero driveHero">
      <div><p className="stepLabel">GOOGLE DRIVE AUTO CLINIC</p><h2>범위만 적으면<br />자료부터 확인합니다.</h2><p className="heroCopy">학교별 원본·정답·리테·표지를 먼저 대조합니다. 하나라도 없거나 후보가 겹치면 자동 생성을 멈추고 이유를 보고합니다.</p></div>
      <div className="safetyCard"><strong>오류 방지 4단계</strong><ol><li>학교 폴더 일치</li><li>문제·정답 쌍 확인</li><li>범위와 PDF 구조 대조</li><li>검증 통과 자료만 생성</li></ol></div>
    </section>
    <section className="driveConnection">
      <div className={`connectionDot ${connection?.connected ? "ok" : "off"}`} />
      <div><strong>{connection?.connected ? "Google Drive 연결됨" : "Google Drive 연결 준비 필요"}</strong><p>{connection?.connected ? `공유 폴더에서 PDF ${connection.pdfCount ?? connection.fileCount}개 확인` : connection?.error ?? "관리자가 공유 폴더와 읽기 권한을 연결하면 바로 사용할 수 있습니다."}</p></div>
      <button onClick={() => location.reload()}>연결 새로 확인</button>
    </section>
    <section className="scopeComposer">
      <div className="scopeHeader"><div><p className="stepLabel">1. 범위 입력</p><h3>학교별로 한 줄씩 적어주세요</h3></div><span>학교명: 교재·단원·지문/문항</span></div>
      <textarea value={scope} onChange={(event) => setScope(event.target.value)} aria-label="학교별 클리닉 범위" />
      <button className="primaryButton" disabled={busy || !connection?.connected || !scope.trim()} onClick={inspect}>{busy ? "자료 확인 중…" : "Drive에서 자료 찾기"}</button>
    </section>
    {progress && <div className="notice success"><i /> {progress}</div>}
    {message && <div className="notice success">{message}</div>}
    {error && <div className="notice error preserveLines">{error}</div>}
    {plan && <section className="planSection">
      <div className="planToolbar"><div><p className="stepLabel">2. 자료 현황</p><h3>생성 전 점검 결과</h3></div><button onClick={() => csv(plan)}>현황표 CSV 받기</button></div>
      <div className="planList">{plan.jobs.map((job) => <article className={`planJob ${job.status}`} key={job.id}>
        <header><div><h4>{job.school}</h4><p>{job.scope}</p></div><span>{statusName[job.status]}</span></header>
        <div className="materialGrid">{(Object.keys(roleName) as Role[]).map((role) => <div key={role}><strong>{roleName[role]}</strong>{job.materials[role].length === 1 ? <p title={job.materials[role][0].path}>{job.materials[role][0].name}</p> : job.materials[role].length > 1 ? <p className="warn">후보 {job.materials[role].length}개</p> : <p className="missing">없음</p>}</div>)}</div>
        <footer>{job.note}</footer>
      </article>)}</div>
      <button className="primaryButton" disabled={busy || readyCount === 0} onClick={generateReady}>검증 통과 {readyCount}개 학교 완성본 만들기</button>
      <p className="footnote">세부 지문·모의고사 문항 범위는 PDF 내부의 지문 번호와 출처를 추가 대조해야 하므로 자동 생성하지 않습니다.</p>
    </section>}
  </>;
}
