"use client";

import { DragEvent, useState } from "react";
import {
  analyzeAnswerWorkbook,
  analyzeWorkbook,
  AnswerWorkbookAnalysis,
  buildClinicAnswerPdf,
  buildClinicPdf,
  WorkbookAnalysis,
} from "./pdf-engine";
import HanyoungMaker from "./hanyoung";
import DriveMaker from "./drive-maker";

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
  const [mode, setMode] = useState<"general" | "hanyoung" | "drive">("general");
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
    if (files.length < 2 || files.length > 4) { setError("워크북과 리테를 포함해 PDF 2~4개를 선택하세요."); return; }
    if (files.some((file) => !isPdf(file))) { setError("PDF 파일만 올릴 수 있습니다."); return; }
    if (files.some((file) => file.size > 100 * 1024 * 1024)) { setError("각 PDF는 100MB 이하만 사용할 수 있습니다."); return; }
    const { slots, duplicate } = classifyFiles(files);
    if (duplicate || !slots.workbook || !slots.rete) {
      setError("워크북과 리테를 자동 구분하지 못했습니다. 리테 파일명에 ‘리테’가 들어 있는지 확인한 뒤 다시 올려주세요.");
      return;
    }
    setWorkbook(slots.workbook); setRete(slots.rete);
    setWorkbookAnswer(slots.workbookAnswer ?? null); setReteAnswer(slots.reteAnswer ?? null);
    setAnalysis(null); setAnswerAnalysis(null); setBusy(true);
    setStatus("파일을 구분하고 워크북 구조를 분석하고 있습니다…");
    try {
      const questionResult = await analyzeWorkbook(new Uint8Array(await slots.workbook.arrayBuffer()));
      if (!questionResult.c1Groups.length) throw new Error("워크북에서 C1 문장배열 페이지를 찾지 못했습니다.");
      const detectedSection = inferSection(slots.rete.name, questionResult.c1Groups.length);
      let validAnswerAnalysis: AnswerWorkbookAnalysis | null = null;
      if (slots.workbookAnswer && slots.reteAnswer) {
        try {
          const result = await analyzeAnswerWorkbook(new Uint8Array(await slots.workbookAnswer.arrayBuffer()));
          if (result.c1Sections.length && (!questionResult.c2Groups.length || result.c2Sections.length)) validAnswerAnalysis = result;
        } catch { validAnswerAnalysis = null; }
      }
      setAnalysis(questionResult); setAnswerAnalysis(validAnswerAnalysis);
      if (validAnswerAnalysis) setStatus(`${detectedSection}과로 확인했습니다. 클리닉과 정답지를 만들 수 있습니다.`);
      else setStatus(`${detectedSection}과로 확인했습니다. 정답 자료가 부족해 클리닉 문제지만 생성합니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "파일 분석에 실패했습니다."); setStatus(""); }
    finally { setBusy(false); }
  }

  function dropFiles(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    void acceptBatch(event.dataTransfer.files);
  }

  async function generate() {
    if (!workbook || !rete || !analysis) return;
    const wantsAnswer = Boolean(workbookAnswer && reteAnswer && answerAnalysis);
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
      <nav className="categoryTabs"><button className={mode === "general" ? "active" : ""} onClick={() => setMode("general")}>직접 업로드</button><button className={mode === "hanyoung" ? "active" : ""} onClick={() => setMode("hanyoung")}>한영고</button><button className={mode === "drive" ? "active" : ""} onClick={() => setMode("drive")}>Drive 자동 제작</button></nav>
      {mode === "drive" ? <DriveMaker /> : mode === "hanyoung" ? <HanyoungMaker /> : <>
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
          <span className="dropIcon">2+</span>
          <div><h3>PDF 2~4개를 여기에 한 번에 드래그</h3><p>워크북 · 리테는 필수이며, 정답 파일이 충분하면 정답지도 함께 만듭니다.</p></div>
          <strong>PDF 파일 선택</strong>
          <input type="file" accept="application/pdf" multiple onChange={(event) => event.target.files && void acceptBatch(event.target.files)} />
          {uploadedFiles.some(([, file]) => file) && <div className="uploadedList">
            {uploadedFiles.map(([role, file]) => file && <div key={role}><span>{role}</span><p>{file.name}</p><b>완료</b></div>)}
          </div>}
        </label>
      </section>
      {status && <div className="notice success">{busy && <i />} {status}</div>}
      {error && <div className="notice error">{error}</div>}
      <button className="primaryButton" disabled={!workbook || !rete || !analysis || busy} onClick={generate}>{busy ? "처리 중…" : (workbookAnswer && reteAnswer && answerAnalysis ? "클리닉 2개 추출 및 다운로드" : "클리닉 문제지 추출 및 다운로드")}</button>
      {downloads && <div className="downloadPanel">
        <p>다운로드가 시작되었습니다. 자동으로 내려받지 않으면 아래 버튼을 누르세요.</p>
        <div>
          <a href={downloads.questionUrl} download={`클리닉_${downloads.baseName}.pdf`}>문제지 다운로드</a>
          {downloads.answerUrl && <a href={downloads.answerUrl} download={`클리닉_정답_${downloads.baseName}.pdf`}>정답지 다운로드</a>}
        </div>
      </div>}
      <p className="footnote">PDF는 서버에 저장되지 않으며 현재 브라우저 안에서만 처리됩니다.</p>
      </>}
    </main>
  );
}
