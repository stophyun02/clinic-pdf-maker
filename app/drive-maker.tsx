"use client";

import { useEffect, useMemo, useState } from "react";
import { PDFDocument } from "pdf-lib";
import { analyzeAnswerWorkbook, analyzeWorkbook, buildClinicAnswerPdf, buildClinicPdf } from "./pdf-engine";

type Role = "workbook" | "workbookAnswer" | "rete" | "reteAnswer" | "cover";
type Status = "ready" | "questionReady" | "missing" | "ambiguous" | "review";
type Candidate = { id: string; name: string; path: string; size?: string; modifiedTime?: string };
type Job = {
  id: number; school: string; scope: string; status: Status;
  options: { excludeC2: boolean; excludeFurther: boolean };
  materials: Record<Role, Candidate[]>; missing: Role[]; ambiguous: Role[];
  checks: { label: string; state: string }[]; note: string;
};
type Plan = { scannedAt: string; fileCount: number; week: string; counts: Record<Status, number>; jobs: Job[] };

const roleName: Record<Role, string> = { workbook: "워크북", workbookAnswer: "워크북 정답", rete: "리테", reteAnswer: "리테 정답", cover: "표지" };
const statusMeta: Record<Status, { label: string; description: string }> = {
  ready: { label: "완성본 가능", description: "문제와 정답 자료가 모두 확인되었습니다." },
  questionReady: { label: "문제지만 가능", description: "정답 자료가 들어오면 완성본으로 갱신합니다." },
  review: { label: "내용 검수 필요", description: "지문·문항 범위를 원문과 대조해야 합니다." },
  missing: { label: "자료 부족", description: "필수 문제 자료가 없습니다." },
  ambiguous: { label: "후보 확인", description: "동일 조건의 파일이 여러 개입니다." },
};
const defaultScope = `<3주차>
강동고1: 25년 10월 모의고사 24번, 29번, 32번
배재고1: 공통영어2 능률(오) 2과
한영고1: 마더텅 11강 20~40번 (영작배열 제외)`;

async function loadPdf(candidate: Candidate, localFiles: Map<string, File>) {
  const local = localFiles.get(candidate.id);
  if (local) return new Uint8Array(await local.arrayBuffer());
  const response = await fetch(`/api/drive/file?id=${encodeURIComponent(candidate.id)}`);
  if (!response.ok) throw new Error(`${candidate.name}을 불러오지 못했습니다.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function assemble(coverBytes: Uint8Array | null, questionBytes: Uint8Array, answerBytes?: Uint8Array) {
  const question = await PDFDocument.load(questionBytes);
  const answer = answerBytes ? await PDFDocument.load(answerBytes) : null;
  const cover = coverBytes ? await PDFDocument.load(coverBytes) : null;
  const output = await PDFDocument.create();
  if (cover && cover.getPageCount() >= 1) (await output.copyPages(cover, [0])).forEach((page) => output.addPage(page));
  (await output.copyPages(question, question.getPageIndices())).forEach((page) => output.addPage(page));
  if (answer) (await output.copyPages(answer, answer.getPageIndices())).forEach((page) => output.addPage(page));
  if (cover && cover.getPageCount() >= 3) (await output.copyPages(cover, [1, 2])).forEach((page) => output.addPage(page));
  return output.save({ useObjectStreams: true });
}

function save(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a"); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

function reportCsv(plan: Plan) {
  const rows = [["학교", "범위", "상태", "누락", "중복", "비고"], ...plan.jobs.map((job) => [
    job.school, job.scope, statusMeta[job.status].label, job.missing.map((role) => roleName[role]).join(" / "), job.ambiguous.map((role) => roleName[role]).join(" / "), job.note,
  ])];
  const content = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  save(new TextEncoder().encode(`\ufeff${content}`), `${plan.week}_클리닉_자료현황.csv`);
}

export default function DriveMaker() {
  const [scope, setScope] = useState(defaultScope);
  const [connection, setConnection] = useState<{ connected: boolean; fileCount: number; pdfCount?: number; rootCount?: number; rootNames?: string[]; error?: string } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [confirmed, setConfirmed] = useState(false);
  const [localUploads, setLocalUploads] = useState<File[]>([]);
  const localFileMap = useMemo(() => new Map(localUploads.map((file, index) => [`local:${index}`, file])), [localUploads]);
  const visibleJobs = useMemo(() => plan?.jobs.filter((job) => filter === "all" || job.status === filter) ?? [], [plan, filter]);
  const buildableCount = useMemo(() => plan?.jobs.filter((job) => job.status === "ready" || job.status === "questionReady").length ?? 0, [plan]);

  useEffect(() => {
    fetch("/api/drive/status").then((response) => response.json()).then(setConnection).catch(() => setConnection({ connected: false, fileCount: 0 }));
  }, []);

  function localRole(file: File): Role | null {
    const name = file.name.normalize("NFKC").toLowerCase();
    const answer = name.includes("정답") || name.includes("answer");
    const rete = name.includes("리테") || name.includes("리뷰") || name.includes("review");
    if (name.includes("표지")) return "cover";
    if (rete) return answer ? "reteAnswer" : "rete";
    if (name.includes("워크북") || name.includes("내지")) return answer ? "workbookAnswer" : "workbook";
    return null;
  }

  function mergeLocalFiles(payload: Plan): Plan {
    const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    const jobs = payload.jobs.map((job) => {
      const materials = { ...job.materials };
      for (const role of Object.keys(roleName) as Role[]) materials[role] = [...materials[role]];
      localUploads.forEach((file, index) => {
        const role = localRole(file);
        if (!role) return;
        if (payload.jobs.length > 1 && !normalized(file.name).includes(normalized(job.school))) return;
        materials[role].push({ id: `local:${index}`, name: file.name, path: "직접 업로드" });
      });
      const ambiguous = (Object.keys(roleName) as Role[]).filter((role) => materials[role].length > 1);
      const missing = (Object.keys(roleName) as Role[]).filter((role) => materials[role].length === 0);
      const questionReady = materials.workbook.length === 1 && materials.rete.length === 1;
      const answerReady = materials.workbookAnswer.length === 1 && materials.reteAnswer.length === 1;
      let status = job.status;
      if (ambiguous.length) status = "ambiguous";
      else if (!questionReady) status = "missing";
      else if (job.status === "review") status = "review";
      else status = answerReady ? "ready" : "questionReady";
      return { ...job, materials, missing, ambiguous, status };
    });
    const counts = Object.fromEntries((Object.keys(statusMeta) as Status[]).map((status) => [status, jobs.filter((job) => job.status === status).length])) as Record<Status, number>;
    return { ...payload, jobs, counts, fileCount: payload.fileCount + localUploads.length };
  }

  async function inspect() {
    setBusy(true); setError(""); setMessage(""); setPlan(null); setConfirmed(false); setFilter("all");
    setProgress("Drive 자료를 학교별로 분류하고 있습니다…");
    try {
      const response = await fetch("/api/drive/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "자료 검색에 실패했습니다.");
      const merged = mergeLocalFiles(payload);
      setPlan(merged);
      setMessage(`${payload.week} · ${payload.jobs.length}개 학교의 자료 현황을 만들었습니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "자료 검색에 실패했습니다."); }
    finally { setBusy(false); setProgress(""); }
  }

  async function generateBuildable() {
    if (!plan || !confirmed || !buildableCount) return;
    setBusy(true); setError(""); setMessage("");
    let completed = 0;
    const failures: string[] = [];
    for (const job of plan.jobs.filter((item) => item.status === "ready" || item.status === "questionReady")) {
      try {
        setProgress(`${job.school} PDF 구조를 검증하고 있습니다…`);
        const one = (role: Role) => job.materials[role][0];
        const [wb, rete, cover] = await Promise.all([
          loadPdf(one("workbook"), localFileMap), loadPdf(one("rete"), localFileMap), one("cover") ? loadPdf(one("cover"), localFileMap) : Promise.resolve(null),
        ]);
        const analysis = await analyzeWorkbook(wb);
        const lesson = Number(job.scope.match(/(\d+)\s*과/)?.[1] ?? 1);
        if (!analysis.c1Groups.length || lesson > analysis.c1Groups.length) throw new Error("요청 범위와 워크북 문장배열 구조가 일치하지 않습니다.");
        const includeC2 = !job.options.excludeC2 && analysis.c2Groups.length > 0;
        const question = await buildClinicPdf(wb, rete, analysis, lesson, "all", includeC2);
        let answer: Uint8Array | undefined;
        if (job.status === "ready") {
          const [wa, reteAnswer] = await Promise.all([loadPdf(one("workbookAnswer"), localFileMap), loadPdf(one("reteAnswer"), localFileMap)]);
          const answerAnalysis = await analyzeAnswerWorkbook(wa);
          if (!answerAnalysis.c1Sections.length) throw new Error("워크북 정답에서 문장배열 정답을 찾지 못했습니다.");
          if (includeC2 && !answerAnalysis.c2Sections.length) throw new Error("영작배열 정답이 부족합니다.");
          answer = await buildClinicAnswerPdf(wa, reteAnswer, answerAnalysis, lesson, "all", includeC2);
        }
        const final = await assemble(cover, question, answer);
        const suffix = answer ? "완성본" : "문제지";
        save(final, `${plan.week}_${job.school}클리닉_${suffix}.pdf`);
        completed += 1;
      } catch (reason) { failures.push(`${job.school}: ${reason instanceof Error ? reason.message : "생성 실패"}`); }
    }
    setBusy(false); setProgress("");
    if (failures.length) setError(`완료 ${completed}개 · 중단 ${failures.length}개\n${failures.join("\n")}`);
    else setMessage(`${completed}개 학교의 검증된 PDF 다운로드를 시작했습니다.`);
  }

  return <>
    <section className="workspaceIntro">
      <div>
        <p className="stepLabel">WEEKLY CLINIC WORKSPACE</p>
        <h2>범위를 붙여넣고,<br />확인된 자료만 만드세요.</h2>
        <p className="heroCopy">Drive에서 문제·정답·리테·표지를 먼저 대조합니다. 자료가 부족하거나 범위가 세밀하면 자동 생성을 멈추고 이유부터 보여드립니다.</p>
      </div>
      <div className="workflowStrip" aria-label="제작 순서">
        <span><b>01</b> 범위 접수</span><span><b>02</b> 자료 대조</span><span><b>03</b> 내용 검수</span><span><b>04</b> PDF 제작</span>
      </div>
    </section>

    <section className="connectionBar">
      <div className={`connectionDot ${connection?.connected ? "ok" : "off"}`} />
      <div><strong>{connection?.connected ? "자료실 연결됨" : "자료실 연결 필요"}</strong><p>{connection?.connected ? `Drive 폴더 ${connection.rootCount ?? connection.fileCount}개 연결 · ${connection.rootNames?.join(" · ") ?? "검색 준비 완료"}` : connection?.error ?? "관리자 연결 설정을 확인해 주세요."}</p></div>
      <button onClick={() => location.reload()}>새로 확인</button>
    </section>

    <section className="sourcePanel">
      <div>
        <p className="stepLabel">자료 가져오기</p>
        <h3>Drive 자료와 직접 올린 파일을 함께 확인합니다</h3>
        <p>Drive에 없는 워크북·정답·리테·표지만 추가로 올리세요. 학교가 여러 곳이면 파일명에 학교명이 있어야 정확히 연결됩니다.</p>
      </div>
      <label className="inlineUploader">
        <input type="file" accept="application/pdf" multiple onChange={(event) => setLocalUploads(Array.from(event.target.files ?? []))} />
        <strong>{localUploads.length ? `보충 파일 ${localUploads.length}개 선택됨` : "보충 PDF 선택"}</strong>
        <span>{localUploads.length ? localUploads.map((file) => file.name).join(" · ") : "여러 파일을 한 번에 선택할 수 있습니다"}</span>
      </label>
    </section>

    <section className="scopeWorkspace">
      <div className="scopeHeader">
        <div><p className="stepLabel">1. 이번 주 범위</p><h3>받은 범위표를 그대로 붙여넣으세요</h3></div>
        <span>주차·학년 제목은 자동 구분됩니다</span>
      </div>
      <textarea value={scope} onChange={(event) => setScope(event.target.value)} aria-label="학교별 클리닉 범위" />
      <div className="scopeActions"><p>예외 문구도 인식합니다: 영작배열 제외 · Further Reading 제외</p><button disabled={busy || !connection?.connected || !scope.trim()} onClick={inspect}>{busy ? "자료 확인 중…" : "자료 현황 만들기"}</button></div>
    </section>

    {progress && <div className="notice success"><i /> {progress}</div>}
    {message && <div className="notice success">{message}</div>}
    {error && <div className="notice error preserveLines">{error}</div>}

    {plan && <section className="reviewWorkspace">
      <div className="reviewHeading">
        <div><p className="stepLabel">2. 제작 전 검수</p><h3>{plan.week} 작업 현황</h3><p>{new Date(plan.scannedAt).toLocaleString("ko-KR")} 기준 · Drive {plan.fileCount}개 파일 검색</p></div>
        <button className="secondaryButton" onClick={() => reportCsv(plan)}>부족 자료 보고서</button>
      </div>
      <div className="summaryGrid">
        <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}><strong>{plan.jobs.length}</strong><span>전체 학교</span></button>
        {(Object.keys(statusMeta) as Status[]).map((status) => <button className={`${status} ${filter === status ? "selected" : ""}`} key={status} onClick={() => setFilter(status)}><strong>{plan.counts[status] ?? 0}</strong><span>{statusMeta[status].label}</span></button>)}
      </div>
      <div className="jobList">{visibleJobs.map((job) => <article className={`jobCard ${job.status}`} key={job.id}>
        <header>
          <div className="schoolIdentity"><span>{String(job.id).padStart(2, "0")}</span><div><h4>{job.school}</h4><p>{job.scope}</p></div></div>
          <div className="statusPill">{statusMeta[job.status].label}</div>
        </header>
        <div className="jobBody">
          <div className="materialTable">{(Object.keys(roleName) as Role[]).map((role) => {
            const candidates = job.materials[role];
            return <div className={candidates.length === 1 ? "found" : candidates.length > 1 ? "warn" : "empty"} key={role}>
              <span>{roleName[role]}</span>
              <strong title={candidates[0]?.path}>{candidates.length === 1 ? candidates[0].name : candidates.length > 1 ? `후보 ${candidates.length}개` : "자료 없음"}</strong>
            </div>;
          })}</div>
          <aside>
            <p>{job.note}</p>
            <div className="checkChips">{job.checks.map((check) => <span className={check.state} key={check.label}>{check.label}<b>{check.state === "pass" ? "확인" : check.state === "excluded" ? "제외" : check.state === "include" ? "포함" : check.state === "review" ? "검수" : check.state === "warn" ? "대기" : "누락"}</b></span>)}</div>
          </aside>
        </div>
      </article>)}</div>
      {visibleJobs.length === 0 && <div className="emptyState">이 상태에 해당하는 학교가 없습니다.</div>}
      <div className="finalizePanel">
        <div><p className="stepLabel">3. 최종 제작</p><h3>자동 제작 가능한 {buildableCount}개 학교</h3><p>완성본은 표지 → 문장배열 → 리테 → 영작배열 → 정답지 → 마지막표지 순서로 구성됩니다.</p></div>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>범위와 자료 현황을 확인했습니다</span></label>
        <button disabled={busy || !confirmed || buildableCount === 0} onClick={generateBuildable}>{busy ? "제작 중…" : `검증된 ${buildableCount}개 PDF 만들기`}</button>
      </div>
      <p className="footnote">‘내용 검수 필요’ 작업은 자동으로 포함하지 않습니다. 정확한 지문·문항 대조가 완료된 뒤 제작해야 합니다.</p>
    </section>}
  </>;
}
