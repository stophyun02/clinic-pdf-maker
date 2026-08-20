"use client";

import { DragEvent, useEffect, useState } from "react";
import { analyzeHanyoung, buildHanyoungPdf, HanyoungSource, HanyoungWorkbookAnalysis } from "./pdf-engine";

type SavedFile = { year: number; month: number; kind: "question" | "answer"; filename: string; size: number };
const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
const parseReteName = (file: File) => {
  const name = file.name.normalize("NFKC");
  const match = name.match(/(?:고\s*1\s*)?(\d{2,4})\s*년\s*(\d{1,2})\s*월/);
  if (!match) return null;
  let year = Number(match[1]); if (year < 100) year += 2000;
  return { year, month: Number(match[2]), kind: /정답/.test(name) ? "answer" as const : "question" as const };
};
const formatSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(size / 1024))}KB`;

export default function HanyoungMaker() {
  const [workbook, setWorkbook] = useState<File | null>(null); const [answer, setAnswer] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<HanyoungWorkbookAnalysis | null>(null);
  const [start, setStart] = useState(2); const [end, setEnd] = useState(18);
  const [library, setLibrary] = useState<SavedFile[]>([]); const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(""); const [error, setError] = useState("");
  const [downloads, setDownloads] = useState<{ q: string; a?: string } | null>(null);

  const refresh = async () => { const response = await fetch("/api/hanyoung/rete"); if (response.ok) setLibrary((await response.json()).files); };
  useEffect(() => {
    let active = true;
    fetch("/api/hanyoung/rete").then((response) => response.ok ? response.json() : { files: [] }).then((payload) => { if (active) setLibrary(payload.files); });
    return () => { active = false; };
  }, []);

  async function acceptWorkbook(files: File[]) {
    setError(""); if (files.length !== 2 || files.some((f) => !isPdf(f))) return setError("한영고 워크북과 워크북 정답지 PDF 2개를 올려주세요.");
    const answerFile = files.find((f) => /정답/.test(f.name.normalize("NFKC"))); const workbookFile = files.find((f) => f !== answerFile);
    if (!answerFile || !workbookFile) return setError("파일명에 ‘정답’이 포함된 워크북 정답지가 필요합니다.");
    setWorkbook(workbookFile); setAnswer(answerFile); setBusy(true); setStatus("지문 번호와 모의고사 출처를 확인하고 있습니다…");
    try { const result = await analyzeHanyoung(new Uint8Array(await workbookFile.arrayBuffer()), new Uint8Array(await answerFile.arrayBuffer())); setAnalysis(result); setStatus(`${result.sources.length}개 지문의 출처를 확인했습니다.`); }
    catch (e) { setError(e instanceof Error ? e.message : "워크북 분석에 실패했습니다."); setStatus(""); }
    finally { setBusy(false); }
  }

  async function uploadLibrary(files: File[]) {
    setError(""); setBusy(true); let count = 0;
    try {
      for (const file of files) {
        if (!isPdf(file)) throw new Error(`${file.name}: PDF 파일이 아닙니다.`);
        const meta = parseReteName(file); if (!meta) throw new Error(`${file.name}: 파일명에서 연도와 월을 찾지 못했습니다.`);
        const form = new FormData(); form.set("file", file); form.set("year", String(meta.year)); form.set("month", String(meta.month)); form.set("kind", meta.kind);
        const response = await fetch("/api/hanyoung/rete", { method: "POST", body: form }); if (!response.ok) throw new Error((await response.json()).error ?? "저장에 실패했습니다."); count += 1;
      }
      await refresh(); setStatus(`리테 ${count}개를 보관함에 영구 저장했습니다.`);
    } catch (e) { setError(e instanceof Error ? e.message : "리테 저장에 실패했습니다."); }
    finally { setBusy(false); }
  }

  async function generate() {
    if (!workbook || !answer || !analysis) return;
    const passages = analysis.sources.map((x) => x.passage).filter((n) => n >= start && n <= end);
    if (!passages.length) return setError("입력한 범위에 해당하는 지문이 없습니다.");
    const missing = analysis.sources.filter((x) => passages.includes(x.passage)).flatMap((x) => (["question", "answer"] as const).filter((kind) => !library.some((f) => f.year === x.year && f.month === x.month && f.kind === kind)).map((kind) => `${String(x.year).slice(-2)}년 ${x.month}월 ${kind === "question" ? "문제" : "정답"}`));
    if (missing.length) return setError(`리테 보관함에 없는 파일: ${[...new Set(missing)].join(", ")}`);
    setBusy(true); setError(""); setStatus(`${passages.join("·")}번 지문을 순서대로 만들고 있습니다…`);
    const cache = new Map<string, Uint8Array>();
    const loader = async (source: HanyoungSource, kind: "question" | "answer") => { const key = `${source.year}-${source.month}-${kind}`; if (!cache.has(key)) { const response = await fetch(`/api/hanyoung/rete?year=${source.year}&month=${source.month}&kind=${kind}`); if (!response.ok) throw new Error(`${source.year}년 ${source.month}월 리테를 불러오지 못했습니다.`); cache.set(key, new Uint8Array(await response.arrayBuffer())); } return cache.get(key)!; };
    try {
      const wb = new Uint8Array(await workbook.arrayBuffer()); const ans = new Uint8Array(await answer.arrayBuffer());
      const [q, a] = await Promise.all([buildHanyoungPdf(wb, analysis, passages, loader), buildHanyoungPdf(wb, analysis, passages, loader, "answer", ans)]);
      if (downloads) { URL.revokeObjectURL(downloads.q); if (downloads.a) URL.revokeObjectURL(downloads.a); }
      const urls = { q: URL.createObjectURL(new Blob([q], { type: "application/pdf" })), a: URL.createObjectURL(new Blob([a], { type: "application/pdf" })) }; setDownloads(urls);
      for (const [url, name] of [[urls.q, `한영고_클리닉_${start}-${end}.pdf`], [urls.a, `한영고_클리닉_정답_${start}-${end}.pdf`]]) { const link = document.createElement("a"); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); }
      setStatus("한영고 클리닉 문제지와 정답지 다운로드를 시작했습니다.");
    } catch (e) { setError(e instanceof Error ? e.message : "PDF 생성에 실패했습니다."); setStatus(""); }
    finally { setBusy(false); }
  }

  const drop = (handler: (files: File[]) => void) => (event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); void handler(Array.from(event.dataTransfer.files)); };
  return <>
    <section className="hero hanyoungHero"><div><p className="stepLabel">HANYOUNG HIGH SCHOOL</p><h2>입력한 지문 범위만<br />출처까지 자동 조립합니다.</h2><p className="heroCopy">워크북 정답지의 출처를 읽어 해당 연도·월·문제 번호의 리테를 자동으로 찾아 배치합니다.</p></div><div className="orderCard"><span>문장배열</span><b>→</b><span>출처 리테</span><b>→</b><span>영작배열</span></div></section>
    <section className="hyGrid">
      <div className="hyCard"><p className="stepLabel">1. 리테 보관함</p><h3>여러 연도 PDF 미리 저장</h3><label className="smallDrop" onDragOver={(e) => e.preventDefault()} onDrop={drop(uploadLibrary)}>문제·정답 PDF 여러 개 드래그<input type="file" accept="application/pdf" multiple onChange={(e) => e.target.files && void uploadLibrary(Array.from(e.target.files))} /></label><div className="libraryHeader"><p>저장된 파일 {library.length}개</p><span>같은 연도·월은 새 파일로 교체</span></div>{library.length ? <div className="reteFileList">{library.map((file) => <div className="reteFile" key={`${file.year}-${file.month}-${file.kind}`}><span className={`fileKind ${file.kind}`}>{file.kind === "question" ? "문제" : "정답"}</span><div><strong>{file.year}년 {file.month}월</strong><p title={file.filename}>{file.filename}</p></div><small>{formatSize(file.size)}</small></div>)}</div> : <div className="emptyLibrary">아직 저장된 리테 파일이 없습니다.</div>}</div>
      <div className="hyCard"><p className="stepLabel">2. 이번 워크북</p><h3>워크북 + 정답지</h3><label className="smallDrop" onDragOver={(e) => e.preventDefault()} onDrop={drop(acceptWorkbook)}>PDF 2개를 함께 드래그<input type="file" accept="application/pdf" multiple onChange={(e) => e.target.files && void acceptWorkbook(Array.from(e.target.files))} /></label>{workbook && <p className="libraryCount">{workbook.name}<br />{answer?.name}</p>}</div>
    </section>
    <section className="rangeCard"><div><label>시작 지문 번호<input type="number" min="2" max="40" step="2" value={start} onChange={(e) => setStart(Number(e.target.value))} /></label><span>부터</span><label>끝 지문 번호<input type="number" min="2" max="40" step="2" value={end} onChange={(e) => setEnd(Number(e.target.value))} /></label><span>까지</span></div><p>{analysis ? analysis.sources.filter((x) => x.passage >= start && x.passage <= end).map((x) => x.passage).join(" · ") : "워크북을 올리면 실제 지문 번호가 표시됩니다."}</p></section>
    {status && <div className="notice success">{busy && <i />} {status}</div>}{error && <div className="notice error">{error}</div>}
    <button className="primaryButton" disabled={!analysis || busy || start > end} onClick={generate}>{busy ? "처리 중…" : "한영고 클리닉 2개 추출 및 다운로드"}</button>
    {downloads && <div className="downloadPanel"><p>자동 다운로드가 되지 않으면 아래 버튼을 누르세요.</p><div><a href={downloads.q} download={`한영고_클리닉_${start}-${end}.pdf`}>문제지 다운로드</a><a href={downloads.a} download={`한영고_클리닉_정답_${start}-${end}.pdf`}>정답지 다운로드</a></div></div>}
    <p className="footnote">워크북은 브라우저에서 처리되며, 리테 보관함에 등록한 파일만 비공개 저장소에 유지됩니다.</p>
  </>;
}
