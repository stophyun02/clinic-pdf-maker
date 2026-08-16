"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { analyzeWorkbook, buildClinicPdf, WorkbookAnalysis } from "./pdf-engine";

export default function Home() {
  const [workbook, setWorkbook] = useState<File | null>(null);
  const [rete, setRete] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<WorkbookAnalysis | null>(null);
  const [section, setSection] = useState(1);
  const [reteRange, setReteRange] = useState("all");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sectionCount = useMemo(() => Math.min(analysis?.c1Groups.length ?? 0, analysis?.c2Groups.length ?? 0), [analysis]);

  async function chooseWorkbook(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setWorkbook(file); setAnalysis(null); setError("");
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { setError("워크북 PDF는 100MB 이하만 사용할 수 있습니다."); return; }
    setBusy(true); setStatus("워크북 전체 페이지를 분석하고 있습니다…");
    try {
      const result = await analyzeWorkbook(new Uint8Array(await file.arrayBuffer()));
      if (!result.c1Groups.length || !result.c2Groups.length) throw new Error("C1 문장배열 또는 C2 영작배열 페이지를 찾지 못했습니다.");
      setAnalysis(result); setSection(1);
      setStatus(`C1 ${result.c1Groups.flat().length}쪽 · C2 ${result.c2Groups.flat().length}쪽을 찾았습니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "워크북 분석에 실패했습니다."); setStatus(""); }
    finally { setBusy(false); }
  }

  function chooseRete(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size > 100 * 1024 * 1024) { setError("리테 PDF는 100MB 이하만 사용할 수 있습니다."); return; }
    setRete(file); setError("");
  }

  async function generate() {
    if (!workbook || !rete || !analysis) return;
    setBusy(true); setError(""); setStatus("클리닉 PDF를 만들고 있습니다…");
    try {
      const bytes = await buildClinicPdf(
        new Uint8Array(await workbook.arrayBuffer()),
        new Uint8Array(await rete.arrayBuffer()),
        analysis,
        section,
        reteRange,
      );
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `클리닉_${workbook.name.replace(/\.pdf$/i, "")}.pdf`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("완료되었습니다. 다운로드한 PDF를 확인하세요.");
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
          <h2>교재 두 개를 올리면<br />클리닉이 완성됩니다.</h2>
          <p className="heroCopy">문장배열의 하단 보조 문제를 제거하고, 리뷰테스트와 영작배열을 정확한 순서로 합칩니다.</p>
        </div>
        <div className="orderCard"><span>문장배열</span><b>→</b><span>리뷰테스트</span><b>→</b><span>영작배열</span></div>
      </section>
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
      <section className="optionsCard">
        <label><span>워크북 단원</span><select value={section} onChange={(event) => setSection(Number(event.target.value))} disabled={!sectionCount}>{Array.from({length:Math.max(sectionCount,1)},(_,index)=><option key={index+1} value={index+1}>{index+1}과</option>)}</select></label>
        <label><span>리테 페이지 범위</span><input value={reteRange} onChange={(event)=>setReteRange(event.target.value)} placeholder="all 또는 1-5" /></label>
      </section>
      {status && <div className="notice success">{busy && <i />} {status}</div>}
      {error && <div className="notice error">{error}</div>}
      <button className="primaryButton" disabled={!workbook || !rete || !analysis || busy} onClick={generate}>{busy ? "처리 중…" : "클리닉 PDF 만들기"}</button>
      <p className="footnote">PDF는 서버에 저장되지 않으며 현재 브라우저 안에서만 처리됩니다.</p>
    </main>
  );
}
