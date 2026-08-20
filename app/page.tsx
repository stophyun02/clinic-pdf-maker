"use client";

import { ChangeEvent, DragEvent, useState } from "react";
import {
  analyzeAnswerWorkbook,
  analyzeWorkbook,
  AnswerWorkbookAnalysis,
  buildClinicAnswerPdf,
  buildClinicPdf,
  WorkbookAnalysis,
} from "./pdf-engine";

type Downloads = { questionUrl: string; answerUrl?: string; baseName: string } | null;
type FileSlots = { workbook?: File; rete?: File; workbookAnswer?: File; reteAnswer?: File };

const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

function classifyFiles(files: File[]) {
  const slots: FileSlots = {};
  let duplicate = false;
  for (const file of files) {
    const name = file.name.normalize("NFKC").toLowerCase();
    const answer = name.includes("정답") || name.includes("answer");
    const rete = name.includes("리테") || name.includes("리뷰") || name.includes("review") || name.includes("rete");
    const key: keyof FileSlots = answer ? (rete ? "reteAnswer" : "workbookAnswer") : (rete ? "rete" : "workbook");
    if (slots[key]) duplicate = true;
    else slots[key] = file;
  }
  return { slots, duplicate };
}

function inferSection(fileName: string, groupCount: number) {
  if (groupCount <= 1) return 1;
  const name = fileName.normalize("NFKC").toLowerCase();
  const match = name.match(/([1-9])\s*과/) ?? name.match(/(?:lesson|unit|제)\s*([1-9])/);
  const section = match ? Number(match[1]) : 0;
  if (!section || section > groupCount) {
    throw new Error(`리테 파일명에서 단원을 확인하지 못했습니다. 파일명에 1과, 2과처럼 단원 번호를 넣어주세요.`);
  }
  return section;
}

export default function Home() {
  const [workbook, setWorkbook] = useState<File | null>(null);
  const [rete, setRete] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<WorkbookAnalysis | null>(null);
  const [workbookAnswer, setWorkbookAnswer] = useState<File | null>(null);
  const [reteAnswer, setReteAnswer] = useState<File | null>(null);
  const [answerAnalysis, setAnswerAnalysis] = useState<AnswerWorkbookAnalysis | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [downloads, setDownloads] = useState<Downloads>(null);
  const hasC2 = Boolean(analysis?.c2Groups.length);
  const uploadedFiles = [
    ["워크북", workbook], ["리테", rete], ["워크북 정답", workbookAnswer], ["리테 정답", reteAnswer],
  ] as const;

  function startDownload(url: string, name: string) {
    const link = document.createElement("a");
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
  }

  async function acceptBatch(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    setDragging(false); setError(""); setDownloads(null);
    if (files.length !== 4) { setError("PDF 4개를 한 번에 선택하세요: 워크북, 리테, 워크북 정답, 리테 정답"); return; }
    if (files.some((file) => !isPdf(file))) { setError("PDF 파일만 올릴 수 있습니다."); return; }
    if (files.some((file) => file.size > 100 * 1024 * 1024)) { setError("각 PDF는 100MB 이하만 사용할 수 있습니다."); return; }
    const { slots, duplicate } = classifyFiles(files);
    if (duplicate || !slots.workbook || !slots.rete || !slots.workbookAnswer || !slots.reteAnswer) {
      setError("파일명을 자동 구분하지 못했습니다. 파일명에 ‘리테’와 ‘정답’이 들어 있는지 확인하거나 아래에서 각각 선택하세요.");
      return;
    }
    setWorkbook(slots.workbook); setRete(slots.rete);
    setWorkbookAnswer(slots.workbookAnswer); setReteAnswer(slots.reteAnswer);
    setAnalysis(null); setAnswerAnalysis(null); setBusy(true);
    setStatus("4개 파일을 구분하고 워크북 구조를 분석하고 있습니다…");
    try {
      const [questionResult, answerResult] = await Promise.all([
        analyzeWorkbook(new Uint8Array(await slots.workbook.arrayBuffer())),
        analyzeAnswerWorkbook(new Uint8Array(await slots.workbookAnswer.arrayBuffer())),
      ]);
      if (!questionResult.c1Groups.length) throw new Error("워크북에서 C1 문장배열 페이지를 찾지 못했습니다.");
      if (!answerResult.c1Sections.length) throw new Error("워크북 정답지에서 C1 문장배열 정답을 찾지 못했습니다.");
      const detectedSection = inferSection(slots.rete.name, questionResult.c1Groups.length);
      setAnalysis(questionResult); setAnswerAnalysis(answerResult);
      setStatus(questionResult.c2Groups.length
        ? `${detectedSection}과로 자동 확인했습니다. 문제지·정답지를 바로 만들 수 있습니다.`
        : `${detectedSection}과로 자동 확인했습니다. C2가 없어 문장배열과 리테로 구성합니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "파일 분석에 실패했습니다."); setStatus(""); }
    finally { setBusy(false); }
  }

  function dropFiles(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    void acceptBatch(event.dataTransfer.files);
  }

  async function chooseWorkbook(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setWorkbook(file); setAnalysis(null); setError("");
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { setError("워크북 PDF는 100MB 이하만 사용할 수 있습니다."); return; }
    setBusy(true); setStatus("워크북 전체 페이지를 분석하고 있습니다…");
    try {
      const result = await analyzeWorkbook(new Uint8Array(await file.arrayBuffer()));
      if (!result.c1Groups.length) throw new Error("C1 문장배열 페이지를 찾지 못했습니다.");
      setAnalysis(result);
      setStatus(result.c2Groups.length
        ? `C1 ${result.c1Groups.flat().length}쪽 · C2 ${result.c2Groups.flat().length}쪽을 찾았습니다.`
        : `C1 ${result.c1Groups.flat().length}쪽을 찾았습니다. 이 교재에는 C2 영작배열이 없어 문장배열과 리테만 구성합니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "워크북 분석에 실패했습니다."); setStatus(""); }
    finally { setBusy(false); }
  }

  function chooseRete(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size > 100 * 1024 * 1024) { setError("리테 PDF는 100MB 이하만 사용할 수 있습니다."); return; }
    setRete(file); setError("");
  }

  async function chooseWorkbookAnswer(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setWorkbookAnswer(file); setAnswerAnalysis(null); setError(""); setDownloads(null);
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { setError("워크북 정답 PDF는 100MB 이하만 사용할 수 있습니다."); return; }
    setBusy(true); setStatus("워크북 정답지에서 C1/C2 영역을 찾고 있습니다…");
    try {
      const result = await analyzeAnswerWorkbook(new Uint8Array(await file.arrayBuffer()));
      if (!result.c1Sections.length) throw new Error("정답지에서 C1 문장배열 정답을 찾지 못했습니다.");
      setAnswerAnalysis(result);
      setStatus(`정답지에서 C1 ${result.c1Sections.length}개 · C2 ${result.c2Sections.length}개 단원을 찾았습니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "워크북 정답지 분석에 실패했습니다."); setStatus(""); }
    finally { setBusy(false); }
  }

  function chooseReteAnswer(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size > 100 * 1024 * 1024) { setError("리테 정답 PDF는 100MB 이하만 사용할 수 있습니다."); return; }
    setReteAnswer(file); setError(""); setDownloads(null);
  }

  async function generate() {
    if (!workbook || !rete || !analysis) return;
    const wantsAnswer = Boolean(workbookAnswer || reteAnswer);
    if (wantsAnswer && (!workbookAnswer || !reteAnswer || !answerAnalysis)) {
      setError("정답지를 만들려면 워크북 정답과 리테 정답 PDF를 모두 선택하세요.");
      return;
    }
    setBusy(true); setError(""); setStatus("클리닉 PDF를 만들고 있습니다…");
    try {
      const section = inferSection(rete.name, analysis.c1Groups.length);
      if (downloads) {
        URL.revokeObjectURL(downloads.questionUrl);
        if (downloads.answerUrl) URL.revokeObjectURL(downloads.answerUrl);
      }
      const questionPromise = buildClinicPdf(
        new Uint8Array(await workbook.arrayBuffer()),
        new Uint8Array(await rete.arrayBuffer()),
        analysis,
        section,
        "all",
      );
      const answerPromise = wantsAnswer
        ? buildClinicAnswerPdf(
            new Uint8Array(await workbookAnswer!.arrayBuffer()),
            new Uint8Array(await reteAnswer!.arrayBuffer()),
            answerAnalysis!, section, "all", hasC2,
          )
        : null;
      const [questionBytes, answerBytes] = await Promise.all([questionPromise, answerPromise]);
      const baseName = workbook.name.replace(/\.pdf$/i, "");
      const questionUrl = URL.createObjectURL(new Blob([questionBytes], { type: "application/pdf" }));
      const answerUrl = answerBytes ? URL.createObjectURL(new Blob([answerBytes], { type: "application/pdf" })) : undefined;
      setDownloads({ questionUrl, answerUrl, baseName });
      startDownload(questionUrl, `클리닉_${baseName}.pdf`);
      if (answerUrl) window.setTimeout(() => startDownload(answerUrl, `클리닉_정답_${baseName}.pdf`), 350);
      setStatus(answerBytes ? "완성된 문제지와 정답지 다운로드를 시작했습니다." : "완성된 문제지 다운로드를 시작했습니다.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "PDF 생성에 실패했습니다."); setStatus(""); }
    finally { setBusy(false); }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brandMark">C</div>
        <div><p className="eyebrow">ENGLISH CLINIC MAKER</p><h1>클리닉 PDF 만들기</h1></div>
        <span className="privacyBadge">비공개 · 브라우저 처리</span>
      </header>
      <section className="hero">
        <div>
          <p className="stepLabel">WORKFLOW 01</p>
          <h2>문제지와 정답지를<br />한 번에 완성합니다.</h2>
          <p className="heroCopy">문장배열과 영작배열만 골라 리뷰테스트와 합칩니다. 영작배열이 없는 교재는 문장배열과 리테만 자동 구성합니다.</p>
        </div>
        <div className="orderCard"><span>문장배열</span><b>→</b><span>리뷰테스트</span><b>→</b><span>영작배열(있는 경우)</span></div>
      </section>
      <section className={`batchDrop ${dragging ? "isDragging" : ""}`}>
        <label
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={dropFiles}
        >
          <span className="dropIcon">4</span>
          <div><h3>PDF 4개를 여기에 한 번에 드래그</h3><p>워크북 · 리테 · 워크북 정답 · 리테 정답을 자동으로 구분합니다.</p></div>
          <strong>4개 파일 선택</strong>
          <input type="file" accept="application/pdf" multiple onChange={(event) => event.target.files && void acceptBatch(event.target.files)} />
          {uploadedFiles.some(([, file]) => file) && <div className="uploadedList">
            {uploadedFiles.map(([role, file]) => file && <div key={role}><span>{role}</span><p>{file.name}</p><b>완료</b></div>)}
          </div>}
        </label>
      </section>
      <p className="orDivider"><span>또는 아래에서 각각 선택</span></p>
      <div className="sectionTitle"><span>문제지</span><p>필수 파일 2개</p></div>
      <section className="workspace">
        <div className="uploadCard">
          <span className="number">01</span><h3>워크북 PDF</h3><p>C1 문장배열과 C2 영작배열을 자동으로 찾습니다.</p>
          <label className="fileButton">워크북 선택<input type="file" accept="application/pdf" onChange={chooseWorkbook} /></label>
          {workbook && <p className="fileName">{workbook.name}</p>}
        </div>
        <div className="uploadCard">
          <span className="number">02</span><h3>리뷰테스트 PDF</h3><p>클리닉 중간에 넣을 리테 파일을 선택합니다.</p>
          <label className="fileButton">리테 선택<input type="file" accept="application/pdf" onChange={chooseRete} /></label>
          {rete && <p className="fileName">{rete.name}</p>}
        </div>
      </section>
      <div className="sectionTitle answerTitle"><span>정답지</span><p>선택 사항 · 두 파일을 모두 올리면 정답지도 생성됩니다</p></div>
      <section className="workspace">
        <div className="uploadCard compactCard">
          <span className="number">03</span><h3>워크북 정답 PDF</h3><p>C1 문장배열과 C2 영작배열 정답만 남깁니다.</p>
          <label className="fileButton">워크북 정답 선택<input type="file" accept="application/pdf" onChange={chooseWorkbookAnswer} /></label>
          {workbookAnswer && <p className="fileName">{workbookAnswer.name}</p>}
        </div>
        <div className="uploadCard compactCard">
          <span className="number">04</span><h3>리테 정답 PDF</h3><p>워크북 정답 사이에 들어갈 리테 정답입니다.</p>
          <label className="fileButton">리테 정답 선택<input type="file" accept="application/pdf" onChange={chooseReteAnswer} /></label>
          {reteAnswer && <p className="fileName">{reteAnswer.name}</p>}
        </div>
      </section>
      {status && <div className="notice success">{busy && <i />} {status}</div>}
      {error && <div className="notice error">{error}</div>}
      <button className="primaryButton" disabled={!workbook || !rete || !analysis || busy} onClick={generate}>{busy ? "처리 중…" : (workbookAnswer && reteAnswer ? "클리닉 2개 추출 및 다운로드" : "클리닉 문제지 추출 및 다운로드")}</button>
      {downloads && <div className="downloadPanel">
        <p>다운로드가 시작되었습니다. 자동으로 내려받지 않으면 아래 버튼을 누르세요.</p>
        <div>
          <a href={downloads.questionUrl} download={`클리닉_${downloads.baseName}.pdf`}>문제지 다운로드</a>
          {downloads.answerUrl && <a href={downloads.answerUrl} download={`클리닉_정답_${downloads.baseName}.pdf`}>정답지 다운로드</a>}
        </div>
      </div>}
      <p className="footnote">PDF는 서버에 저장되지 않으며 현재 브라우저 안에서만 처리됩니다.</p>
    </main>
  );
}
