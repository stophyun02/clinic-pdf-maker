"use client";

import { useEffect, useMemo, useState } from "react";
import { PDFDocument } from "pdf-lib";
import { analyzeAnswerWorkbook, analyzeHanyoung, analyzeWorkbook, buildClinicAnswerPdf, buildClinicPdf, buildHanyoungPdf, HanyoungSource, parseWorkbookScope } from "./pdf-engine";

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
type JobChoice = {
  scope: string;
  selected: Partial<Record<Role, string>>;
  includeC1: boolean;
  includeRete: boolean;
  includeC2: boolean;
  includeAnswers: boolean;
  includeCover: boolean;
  excludeFurther: boolean;
  allowQuestionOnly: boolean;
  rangeConfirmed: boolean;
};
type InventoryRole = Role | "unclassified";
type InventoryFile = { id: string; name: string; path: string; role: InventoryRole; reason: string; size?: string; modifiedTime?: string };
type SourceType = "textbook" | "mock" | "supplement" | "custom";
type RangeDraft = {
  id: number; grade: "1" | "2"; school: string; customSchool: string; sourceType: SourceType;
  title: string; publisher: string; lesson: string; year: string; month: string; range: string;
  numberMode: "all" | "even" | "odd";
  selectedWorkbookId: string; selectedWorkbookName: string;
  excludeC2: boolean; excludeFurther: boolean;
};

const roleName: Record<Role, string> = { workbook: "워크북", workbookAnswer: "워크북 정답", rete: "리테", reteAnswer: "리테 정답", cover: "표지" };
const statusMeta: Record<Status, { label: string; description: string }> = {
  ready: { label: "완성본 가능", description: "문제와 정답 자료가 모두 확인되었습니다." },
  questionReady: { label: "문제지만 가능", description: "정답 자료가 들어오면 완성본으로 갱신합니다." },
  review: { label: "내용 검수 필요", description: "지문·문항 범위를 원문과 대조해야 합니다." },
  missing: { label: "자료 부족", description: "필수 문제 자료가 없습니다." },
  ambiguous: { label: "후보 확인", description: "동일 조건의 파일이 여러 개입니다." },
};
const schools = ["강동고", "한영고", "배재고", "성덕고", "상일여고", "명일여고", "이대부고", "서울여고", "광성고"];
const emptyDraft = (id: number): RangeDraft => ({ id, grade: "1", school: "강동고", customSchool: "", sourceType: "textbook", title: "", publisher: "", lesson: "", year: "", month: "", range: "", numberMode: "all", selectedWorkbookId: "", selectedWorkbookName: "", excludeC2: false, excludeFurther: false });

function inventoryRole(name: string): { role: InventoryRole; reason: string } {
  const value = name.normalize("NFKC").toLowerCase();
  if (!value.endsWith(".pdf")) return { role: "unclassified", reason: "PDF가 아님" };
  const answer = value.includes("정답") || value.includes("answer");
  const rete = value.includes("리테") || value.includes("리뷰테스트") || value.includes("review");
  if (value.includes("표지")) return { role: "cover", reason: "파일명에 ‘표지’ 포함" };
  if (rete) return { role: answer ? "reteAnswer" : "rete", reason: answer ? "리테/리뷰 + 정답" : "리테/리뷰 문구" };
  if (value.includes("워크북") || value.includes("내지")) return { role: answer ? "workbookAnswer" : "workbook", reason: answer ? "워크북/내지 + 정답" : "워크북/내지 문구" };
  return { role: "unclassified", reason: "분류 키워드 없음" };
}

async function loadPdf(candidate: Candidate, localFiles: Map<string, File>) {
  const local = localFiles.get(candidate.id);
  if (local) return new Uint8Array(await local.arrayBuffer());
  const response = await fetch(candidate.id.startsWith("cover:") ? `/api/drive/covers?id=${encodeURIComponent(candidate.id.slice(6))}` : `/api/drive/file?id=${encodeURIComponent(candidate.id)}`);
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

async function mergePdfs(parts: (Uint8Array | null | undefined)[]) {
  const output = await PDFDocument.create();
  for (const bytes of parts) {
    if (!bytes) continue;
    const source = await PDFDocument.load(bytes.slice());
    const copied = await output.copyPages(source, source.getPageIndices());
    copied.forEach((page) => output.addPage(page));
  }
  if (!output.getPageCount()) throw new Error("병합할 PDF 페이지가 없습니다.");
  return output.save({ useObjectStreams: true });
}

function save(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a"); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

async function apiJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(response.status === 401 || response.status === 403 || response.redirected
      ? "로그인이 만료되었습니다. 페이지를 새로고침한 뒤 다시 로그인해 주세요."
      : "사이트 응답을 확인하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
  }
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "요청을 처리하지 못했습니다.");
  return payload;
}

function reportCsv(plan: Plan) {
  const rows = [["학교", "범위", "상태", "누락", "중복", "비고"], ...plan.jobs.map((job) => [
    job.school, job.scope, statusMeta[job.status].label, job.missing.map((role) => roleName[role]).join(" / "), job.ambiguous.map((role) => roleName[role]).join(" / "), job.note,
  ])];
  const content = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  save(new TextEncoder().encode(`\ufeff${content}`), `${plan.week}_클리닉_자료현황.csv`);
}

export default function DriveMaker() {
  const [scope, setScope] = useState("");
  const [connection, setConnection] = useState<{ connected: boolean; fileCount: number; pdfCount?: number; rootCount?: number; rootNames?: string[]; error?: string } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [confirmed, setConfirmed] = useState(false);
  const [localUploads, setLocalUploads] = useState<File[]>([]);
  const [covers, setCovers] = useState<{ id: string; name: string; size?: string; modifiedTime?: string }[]>([]);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverMessage, setCoverMessage] = useState("");
  const [inventory, setInventory] = useState<InventoryFile[]>([]);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [inventoryProgress, setInventoryProgress] = useState("");
  const [inventoryFilter, setInventoryFilter] = useState<"all" | InventoryRole>("all");
  const [choices, setChoices] = useState<Record<number, JobChoice>>({});
  const [outputMode, setOutputMode] = useState<"combined" | "separate">("combined");
  const [weekNumber, setWeekNumber] = useState("2");
  const [drafts, setDrafts] = useState<RangeDraft[]>([emptyDraft(1)]);
  const [workbookOptions, setWorkbookOptions] = useState<Record<number, Candidate[]>>({});
  const [workbookSearch, setWorkbookSearch] = useState<Record<number, string>>({});
  const localFileMap = useMemo(() => new Map(localUploads.map((file, index) => [`local:${index}`, file])), [localUploads]);
  const visibleJobs = useMemo(() => plan?.jobs.filter((job) => filter === "all" || job.status === filter) ?? [], [plan, filter]);
  const selectedCandidate = (job: Job, role: Role) => {
    const id = choices[job.id]?.selected[role];
    return job.materials[role].find((candidate) => candidate.id === id);
  };
  const isHanyoungSpecial = (job: Job) => /한영고1/.test(job.school) && /마더텅/.test(job.scope);
  const jobCanBuild = (job: Job) => {
    const choice = choices[job.id];
    if (!choice?.rangeConfirmed || !choice.includeC1 || !choice.includeRete) return false;
    if (!selectedCandidate(job, "workbook")) return false;
    if (isHanyoungSpecial(job)) return Boolean(selectedCandidate(job, "workbookAnswer"));
    if (!selectedCandidate(job, "rete")) return false;
    if (choice.includeAnswers && !choice.allowQuestionOnly && (!selectedCandidate(job, "workbookAnswer") || !selectedCandidate(job, "reteAnswer"))) return false;
    return true;
  };
  const schoolGroups = () => {
    if (!plan) return [];
    const buildableJobs = plan.jobs.filter(jobCanBuild);
    const grouped = new Map<string, Job[]>();
    for (const job of buildableJobs) grouped.set(job.school, [...(grouped.get(job.school) ?? []), job]);
    return [...grouped].filter(([school, jobs]) => jobs.length === plan.jobs.filter((job) => job.school === school).length);
  };
  const buildableCount = useMemo(() => schoolGroups().length, [plan, choices]);

  function defaultChoices(payload: Plan) {
    return Object.fromEntries(payload.jobs.map((job) => [job.id, {
      scope: job.scope,
      selected: Object.fromEntries((Object.keys(roleName) as Role[]).map((role) => [role, job.materials[role].length === 1 ? job.materials[role][0].id : ""])),
      includeC1: true,
      includeRete: true,
      includeC2: !job.options.excludeC2,
      includeAnswers: true,
      includeCover: true,
      excludeFurther: job.options.excludeFurther,
      allowQuestionOnly: true,
      rangeConfirmed: false,
    }])) as Record<number, JobChoice>;
  }

  function updateChoice(jobId: number, patch: Partial<JobChoice>) {
    setChoices((current) => ({ ...current, [jobId]: { ...current[jobId], ...patch } }));
    setConfirmed(false);
  }

  function updateDraft(id: number, patch: Partial<RangeDraft>) {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
  }

  async function findSchoolWorkbooks(draft: RangeDraft) {
    const school = `${draft.school === "직접입력" ? draft.customSchool.trim() : draft.school}${draft.grade}`;
    setWorkbookSearch((current) => ({ ...current, [draft.id]: "Drive에서 찾는 중…" }));
    try {
      const payload = await apiJson<{ workbooks: Candidate[] }>(`/api/drive/materials?school=${encodeURIComponent(school)}`);
      setWorkbookOptions((current) => ({ ...current, [draft.id]: payload.workbooks }));
      if (payload.workbooks.length === 1) updateDraft(draft.id, { selectedWorkbookId: payload.workbooks[0].id, selectedWorkbookName: payload.workbooks[0].name, title: "", publisher: "" });
      else updateDraft(draft.id, { selectedWorkbookId: "", selectedWorkbookName: "" });
      setWorkbookSearch((current) => ({ ...current, [draft.id]: payload.workbooks.length ? `${payload.workbooks.length}개 발견` : "해당 학교의 교과서 워크북이 없습니다." }));
    } catch (reason) { setWorkbookSearch((current) => ({ ...current, [draft.id]: reason instanceof Error ? reason.message : "자료 검색 실패" })); }
  }

  function draftScope(draft: RangeDraft) {
    const school = `${draft.school === "직접입력" ? draft.customSchool.trim() : draft.school}${draft.grade}`;
    let detail = draft.range.trim();
    if (draft.sourceType === "textbook") detail = `${draft.title.trim()}${draft.publisher.trim() ? ` ${draft.publisher.trim()}` : ""}${draft.lesson.trim() ? ` ${draft.lesson.trim()}과` : ""}${detail ? ` ${detail}` : " 본문전체"}`;
    if (draft.sourceType === "mock") detail = `${draft.year.trim()}년 ${draft.month.trim()}월 모의고사 ${detail}${detail && !detail.endsWith("번") ? "번" : ""}`;
    if (draft.sourceType === "supplement") detail = `${draft.title.trim()}${draft.lesson.trim() ? ` ${draft.lesson.trim()}강` : ""}${detail ? ` ${detail}` : ""}`;
    const exceptions = [draft.numberMode === "even" ? "짝수 번호만" : draft.numberMode === "odd" ? "홀수 번호만" : "", draft.excludeC2 ? "영작배열 제외" : "", draft.excludeFurther ? "Further Reading 제외" : ""].filter(Boolean);
    return `${school}: ${detail.trim()}${exceptions.length ? ` (${exceptions.join(" · ")})` : ""}`;
  }

  function structuredScope() {
    return `<${weekNumber || "1"}주차>\n${drafts.map(draftScope).join("\n")}`;
  }

  function draftValid(draft: RangeDraft) {
    if (draft.school === "직접입력" && !draft.customSchool.trim()) return false;
    if (draft.sourceType === "textbook") return Boolean((draft.selectedWorkbookId || draft.title.trim()) && draft.lesson.trim());
    if (draft.sourceType === "mock") return Boolean(draft.year.trim() && draft.month.trim() && draft.range.trim());
    if (draft.sourceType === "supplement") return Boolean(draft.title.trim() && draft.lesson.trim() && draft.range.trim());
    return Boolean(draft.range.trim());
  }

  useEffect(() => {
    apiJson<{ connected: boolean; fileCount: number; pdfCount?: number; rootCount?: number; rootNames?: string[]; error?: string }>("/api/drive/status")
      .then(setConnection).catch((reason) => setConnection({ connected: false, fileCount: 0, error: reason instanceof Error ? reason.message : "자료실 연결을 확인하지 못했습니다." }));
    apiJson<{ covers?: { id: string; name: string; size?: string; modifiedTime?: string }[] }>("/api/drive/covers")
      .then((payload) => setCovers(payload.covers ?? [])).catch(() => setCovers([]));
  }, []);

  async function saveCover(file: File) {
    setCoverBusy(true); setCoverMessage("");
    try {
      const form = new FormData(); form.append("file", file);
      const payload = await apiJson<{ cover: { id: string; name: string; size?: string; modifiedTime?: string } }>("/api/drive/covers", { method: "POST", body: form });
      setCovers((current) => [payload.cover, ...current.filter((item) => item.id !== payload.cover.id)]);
      setCoverMessage(`${payload.cover.name}을 비공개 표지 자료실에 저장했습니다.`);
    } catch (reason) { setCoverMessage(reason instanceof Error ? reason.message : "표지 저장에 실패했습니다."); }
    finally { setCoverBusy(false); }
  }

  async function scanInventory() {
    setInventoryBusy(true); setInventory([]); setInventoryProgress("최상위 자료실을 확인하고 있습니다…");
    try {
      const rootPayload = await apiJson<{ roots: { id: string; name: string }[] }>("/api/drive/browse");
      const queue: { id: string; path: string }[] = rootPayload.roots.map((root: { id: string; name: string }) => ({ id: root.id, path: root.name }));
      const found: InventoryFile[] = [];
      let folders = 0;
      while (queue.length && folders < 500) {
        const folder = queue.shift()!;
        const payload = await apiJson<{ items: { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }[] }>(`/api/drive/browse?folderId=${encodeURIComponent(folder.id)}`);
        folders += 1;
        for (const item of payload.items as { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }[]) {
          const path = `${folder.path}/${item.name}`;
          if (item.mimeType === "application/vnd.google-apps.folder") queue.push({ id: item.id, path });
          else if (item.mimeType === "application/pdf" || item.name.toLowerCase().endsWith(".pdf")) {
            const classified = inventoryRole(item.name);
            found.push({ id: item.id, name: item.name, path, ...classified, size: item.size, modifiedTime: item.modifiedTime });
          }
        }
        if (folders % 3 === 0 || !queue.length) {
          setInventory([...found]);
          setInventoryProgress(`폴더 ${folders}개 확인 · PDF ${found.length}개 분류`);
        }
      }
      setInventory(found);
      setInventoryProgress(`분류 완료 · 폴더 ${folders}개 · PDF ${found.length}개`);
    } catch (reason) { setInventoryProgress(reason instanceof Error ? reason.message : "자료 분류에 실패했습니다."); }
    finally { setInventoryBusy(false); }
  }

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

  async function inspect(scopeOverride?: string) {
    const requestedScope = scopeOverride ?? scope;
    setScope(requestedScope);
    setBusy(true); setError(""); setMessage(""); setPlan(null); setConfirmed(false); setFilter("all");
    setProgress("Drive 자료를 학교별로 분류하고 있습니다…");
    try {
      const selectedWorkbooks = drafts.map((draft, index) => ({ jobId: index + 1, fileId: draft.selectedWorkbookId })).filter((selection) => selection.fileId);
      const payload = await apiJson<Plan>("/api/drive/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: requestedScope, selectedWorkbooks }) });
      const merged = mergeLocalFiles(payload);
      setPlan(merged);
      setChoices(defaultChoices(merged));
      setMessage(`${payload.week} · ${payload.jobs.length}개 학교의 자료 현황을 만들었습니다.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "자료 검색에 실패했습니다."); }
    finally { setBusy(false); setProgress(""); }
  }

  async function generateBuildable() {
    if (!plan || !confirmed || !buildableCount) return;
    setBusy(true); setError(""); setMessage("");
    let completed = 0;
    const failures: string[] = [];
    for (const [school, jobs] of schoolGroups()) {
      try {
        setProgress(`${school}의 ${jobs.length}개 범위를 원문과 대조하고 있습니다…`);
        if (jobs.length === 1 && isHanyoungSpecial(jobs[0])) {
          const job = jobs[0]; const choice = choices[job.id];
          const workbookCandidate = selectedCandidate(job, "workbook")!; const answerCandidate = selectedCandidate(job, "workbookAnswer")!;
          const [wb, wa] = await Promise.all([loadPdf(workbookCandidate, localFileMap), loadPdf(answerCandidate, localFileMap)]);
          const analysis = await analyzeHanyoung(wb, wa); const parsed = parseWorkbookScope(choice.scope)[0];
          const passages = parsed.items ? parsed.items.map(Number).filter((value) => Number.isInteger(value)) : analysis.sources.map((source) => source.passage);
          const cache = new Map<string, Uint8Array>();
          const loader = async (source: HanyoungSource, kind: "question" | "answer") => {
            const key = `${source.year}-${source.month}-${kind}`;
            if (!cache.has(key)) {
              const response = await fetch(`/api/hanyoung/rete?year=${source.year}&month=${source.month}&kind=${kind}`);
              if (!response.ok) throw new Error(`리테 보관함에 ${source.year}년 ${source.month}월 ${kind === "question" ? "문제" : "정답"}이 없습니다.`);
              cache.set(key, new Uint8Array(await response.arrayBuffer()));
            }
            return cache.get(key)!;
          };
          const question = await buildHanyoungPdf(wb, analysis, passages, loader, "question", undefined, choice.includeC2);
          let answer: Uint8Array | undefined;
          if (choice.includeAnswers) {
            try { answer = await buildHanyoungPdf(wb, analysis, passages, loader, "answer", wa, choice.includeC2); }
            catch (reason) { if (!choice.allowQuestionOnly) throw reason; failures.push(`${school}: 정답지는 중단하고 문제지만 생성 - ${reason instanceof Error ? reason.message : "정답 검증 실패"}`); }
          }
          const coverCandidate = choice.includeCover ? selectedCandidate(job, "cover") : undefined;
          const cover = coverCandidate ? await loadPdf(coverCandidate, localFileMap) : null;
          if (outputMode === "separate" && answer) { save(await assemble(cover, question), `${plan.week}_${school}클리닉_문제지.pdf`); save(answer, `${plan.week}_${school}클리닉_정답지.pdf`); }
          else save(await assemble(cover, question, answer), `${plan.week}_${school}클리닉_${answer ? "완성본" : "문제지"}.pdf`);
          completed += 1; continue;
        }
        const questionC1: Uint8Array[] = []; const questionRete: Uint8Array[] = []; const questionC2: Uint8Array[] = [];
        const answerC1: Uint8Array[] = []; const answerRete: Uint8Array[] = []; const answerC2: Uint8Array[] = [];
        let cover: Uint8Array | null = null; let answerComplete = true;
        for (const job of jobs) {
          const choice = choices[job.id];
          const one = (role: Role) => selectedCandidate(job, role)!;
          const [wb, rete] = await Promise.all([loadPdf(one("workbook"), localFileMap), loadPdf(one("rete"), localFileMap)]);
          if (!cover && choice.includeCover && selectedCandidate(job, "cover")) cover = await loadPdf(one("cover"), localFileMap);
          const analysis = await analyzeWorkbook(wb);
          const scopeParts = parseWorkbookScope(choice.scope);
          if (!analysis.c1Groups.length || scopeParts.some((part) => part.sectionIndex > analysis.c1Groups.length)) throw new Error(`${choice.scope}: 워크북 문장배열 구조가 범위와 일치하지 않습니다.`);
          const includeC2 = choice.includeC2 && analysis.c2Groups.length > 0;
          const questionResult = await buildClinicPdf(wb, rete, analysis, scopeParts, "all", includeC2, choice.excludeFurther);
          questionC1.push(questionResult.c1); questionRete.push(questionResult.rete); if (questionResult.c2) questionC2.push(questionResult.c2);
          if (choice.includeAnswers && selectedCandidate(job, "workbookAnswer") && selectedCandidate(job, "reteAnswer")) {
            try {
              const [wa, reteAnswer] = await Promise.all([loadPdf(one("workbookAnswer"), localFileMap), loadPdf(one("reteAnswer"), localFileMap)]);
              const answerAnalysis = await analyzeAnswerWorkbook(wa);
              const answerResult = await buildClinicAnswerPdf(wa, reteAnswer, answerAnalysis, scopeParts, questionResult.fingerprintGroups, includeC2);
              answerC1.push(answerResult.c1); answerRete.push(answerResult.rete); if (answerResult.c2) answerC2.push(answerResult.c2);
            } catch (reason) {
              if (!choice.allowQuestionOnly) throw reason;
              answerComplete = false;
              failures.push(`${school}: 정답지는 중단하고 문제지만 생성 - ${reason instanceof Error ? reason.message : "정답 검증 실패"}`);
            }
          } else if (choice.includeAnswers) answerComplete = false;
          else answerComplete = false;
        }
        const question = await mergePdfs([...questionC1, ...questionRete, ...questionC2]);
        const answer = answerComplete ? await mergePdfs([...answerC1, ...answerRete, ...answerC2]) : undefined;
        if (outputMode === "separate" && answer) {
          save(await assemble(cover, question), `${plan.week}_${school}클리닉_문제지.pdf`);
          save(answer, `${plan.week}_${school}클리닉_정답지.pdf`);
        } else {
          const final = await assemble(cover, question, answer);
          const suffix = answer ? "완성본" : "문제지";
          save(final, `${plan.week}_${school}클리닉_${suffix}.pdf`);
        }
        completed += 1;
      } catch (reason) { failures.push(`${school}: ${reason instanceof Error ? reason.message : "생성 실패"}`); }
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
        <p>Drive에 없는 워크북·정답·리테·표지만 추가로 올리세요. 학교가 여러 곳이면 파일명에 학교명이 있어야 정확히 연결됩니다. 글자를 읽을 수 없는 이미지형 PDF는 Google OCR로 한 번 더 분석합니다.</p>
      </div>
      <label className="inlineUploader">
        <input type="file" accept="application/pdf" multiple onChange={(event) => setLocalUploads(Array.from(event.target.files ?? []))} />
        <strong>{localUploads.length ? `보충 파일 ${localUploads.length}개 선택됨` : "보충 PDF 선택"}</strong>
        <span>{localUploads.length ? localUploads.map((file) => file.name).join(" · ") : "여러 파일을 한 번에 선택할 수 있습니다"}</span>
      </label>
    </section>

    <section className="coverLibrary">
      <div>
        <p className="stepLabel">표지 자료실</p>
        <h3>학교별 표지를 사이트에 계속 보관하세요</h3>
        <p>Drive는 읽기 전용으로 유지합니다. 파일명에 학교명과 주차를 넣으면 제작할 때 더 정확하게 찾습니다.</p>
      </div>
      <label className={`coverUploader ${coverBusy ? "busy" : ""}`}>
        <input type="file" accept="application/pdf" disabled={coverBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void saveCover(file); event.target.value = ""; }} />
        <strong>{coverBusy ? "비공개 저장 중…" : "표지 PDF 저장"}</strong>
      </label>
      <div className="savedCovers">
        <span>저장된 표지 {covers.length}개</span>
        {covers.slice(0, 5).map((cover) => <b key={cover.id}>{cover.name}</b>)}
        {!covers.length && <small>아직 저장된 표지가 없습니다.</small>}
      </div>
      {coverMessage && <p className="coverMessage">{coverMessage}</p>}
    </section>

    <section className="rangeBuilder">
      <div className="builderHeading">
        <div><p className="stepLabel">1. 이번 주 작업 선택</p><h3>학교와 범위를 직접 선택하세요</h3><p>학교별 카드를 추가하면 선택한 값으로 작업표가 자동 구성됩니다.</p></div>
        <label className="weekSelect"><span>주차</span><select value={weekNumber} onChange={(event) => setWeekNumber(event.target.value)}>{Array.from({ length: 12 }, (_, index) => <option value={String(index + 1)} key={index + 1}>{index + 1}주차</option>)}</select></label>
      </div>
      <div className="draftList">{drafts.map((draft, index) => <article className="draftCard" key={draft.id}>
        <header><strong>{String(index + 1).padStart(2, "0")} 학교 설정</strong><div><button onClick={() => setDrafts((current) => [...current, { ...emptyDraft(Math.max(0, ...current.map((item) => item.id)) + 1), grade: draft.grade, school: draft.school, customSchool: draft.customSchool }])}>같은 학교 범위 추가</button>{drafts.length > 1 && <button onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}>삭제</button>}</div></header>
        <div className="draftGrid basicFields">
          <label><span>학년</span><select value={draft.grade} onChange={(event) => { updateDraft(draft.id, { grade: event.target.value as "1" | "2", selectedWorkbookId: "", selectedWorkbookName: "" }); setWorkbookOptions((current) => ({ ...current, [draft.id]: [] })); }}><option value="1">고1</option><option value="2">고2</option></select></label>
          <label><span>학교</span><select value={draft.school} onChange={(event) => { updateDraft(draft.id, { school: event.target.value, selectedWorkbookId: "", selectedWorkbookName: "" }); setWorkbookOptions((current) => ({ ...current, [draft.id]: [] })); }}>{schools.map((school) => <option key={school}>{school}</option>)}<option>직접입력</option></select></label>
          {draft.school === "직접입력" && <label><span>학교명</span><input value={draft.customSchool} placeholder="학교 이름" onChange={(event) => updateDraft(draft.id, { customSchool: event.target.value })} /></label>}
          <label><span>범위 종류</span><select value={draft.sourceType} onChange={(event) => updateDraft(draft.id, { sourceType: event.target.value as SourceType, title: "", publisher: "", lesson: "", year: "", month: "", range: "", numberMode: "all", selectedWorkbookId: "", selectedWorkbookName: "" })}><option value="textbook">교과서</option><option value="mock">모의고사</option><option value="supplement">부교재</option><option value="custom">직접 입력</option></select></label>
        </div>
        <div className="draftGrid rangeFields">
          {draft.sourceType === "textbook" && <><div className="driveBookPicker"><span>Drive 교과서 파일</span><button type="button" onClick={() => void findSchoolWorkbooks(draft)}>학년·학교로 찾기</button><select value={draft.selectedWorkbookId} onChange={(event) => { const candidate = (workbookOptions[draft.id] ?? []).find((item) => item.id === event.target.value); updateDraft(draft.id, { selectedWorkbookId: event.target.value, selectedWorkbookName: candidate?.name ?? "", title: "", publisher: "" }); }}><option value="">{workbookSearch[draft.id] || "먼저 Drive에서 찾아주세요"}</option>{(workbookOptions[draft.id] ?? []).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}</select>{draft.selectedWorkbookName && <small>선택됨: {draft.selectedWorkbookName}</small>}</div><label><span>교재명 (선택)</span><input value={draft.title} disabled={Boolean(draft.selectedWorkbookId)} placeholder="파일을 못 찾을 때만 입력" onChange={(event) => updateDraft(draft.id, { title: event.target.value })} /></label><label><span>출판사·저자 (선택)</span><input value={draft.publisher} disabled={Boolean(draft.selectedWorkbookId)} placeholder="파일을 못 찾을 때만 입력" onChange={(event) => updateDraft(draft.id, { publisher: event.target.value })} /></label><label><span>과</span><input value={draft.lesson} inputMode="numeric" placeholder="예: 2" onChange={(event) => updateDraft(draft.id, { lesson: event.target.value })} /></label><label><span>본문·지문 범위</span><input value={draft.range} placeholder="예: 본문전체 / 1~4번 지문" onChange={(event) => updateDraft(draft.id, { range: event.target.value })} /></label></>}
          {draft.sourceType === "mock" && <><label><span>연도</span><input value={draft.year} inputMode="numeric" placeholder="예: 24" onChange={(event) => updateDraft(draft.id, { year: event.target.value })} /></label><label><span>시행 월</span><select value={draft.month} onChange={(event) => updateDraft(draft.id, { month: event.target.value })}><option value="">선택</option>{[3, 4, 6, 9, 10, 11].map((month) => <option value={String(month)} key={month}>{month}월</option>)}</select></label><label className="wide"><span>문항 번호</span><input value={draft.range} placeholder="예: 20~24, 29~32" onChange={(event) => updateDraft(draft.id, { range: event.target.value })} /></label></>}
          {draft.sourceType === "supplement" && <><label><span>부교재명</span><input value={draft.title} placeholder="예: 마더텅 / 올포" onChange={(event) => updateDraft(draft.id, { title: event.target.value })} /></label><label><span>강</span><input value={draft.lesson} inputMode="numeric" placeholder="예: 11" onChange={(event) => updateDraft(draft.id, { lesson: event.target.value })} /></label><label className="wide"><span>지문 범위</span><input value={draft.range} placeholder="예: 20~40번 / 1~6번 지문" onChange={(event) => updateDraft(draft.id, { range: event.target.value })} /></label></>}
          {draft.sourceType === "custom" && <label className="full"><span>범위 내용</span><input value={draft.range} placeholder="범위를 구체적으로 입력하세요" onChange={(event) => updateDraft(draft.id, { range: event.target.value })} /></label>}
          {(draft.sourceType === "mock" || draft.sourceType === "supplement") && <label><span>번호 선택 방식</span><select value={draft.numberMode} onChange={(event) => updateDraft(draft.id, { numberMode: event.target.value as RangeDraft["numberMode"] })}><option value="all">입력 범위 전체</option><option value="even">짝수 번호만</option><option value="odd">홀수 번호만</option></select></label>}
        </div>
        <div className="draftOptions"><label><input type="checkbox" checked={draft.excludeC2} onChange={(event) => updateDraft(draft.id, { excludeC2: event.target.checked })} />영작배열 제외</label><label><input type="checkbox" checked={draft.excludeFurther} onChange={(event) => updateDraft(draft.id, { excludeFurther: event.target.checked })} />Further Reading 제외</label></div>
        <p className="draftPreview"><span>작업표 미리보기</span>{draftScope(draft)}</p>
      </article>)}</div>
      <p className="compositeHint">교과서+모의고사, 여러 과처럼 범위가 두 개 이상이면 ‘같은 학교 범위 추가’를 누르세요. 같은 학교의 범위는 하나의 클리닉으로 합쳐집니다.</p>
      <div className="builderActions"><button className="addSchool" onClick={() => setDrafts((current) => [...current, emptyDraft(Math.max(0, ...current.map((item) => item.id)) + 1)])}>+ 다른 학교 추가</button><button className="inspectButton" disabled={busy || !connection?.connected || drafts.some((draft) => !draftValid(draft))} onClick={() => void inspect(structuredScope())}>{busy ? "자료 확인 중…" : "선택한 범위로 자료 찾기"}</button></div>
    </section>

    <details className="adminInventory">
      <summary>관리자용 Drive 분류 확인</summary>
      <section className="inventoryPanel">
        <div className="inventoryHeader"><div><h3>파일별 자동 분류 결과</h3><p>파일명과 저장 위치를 기준으로 현재 프로그램의 판단을 확인합니다. 매주 제작에는 필요하지 않습니다.</p></div><button disabled={inventoryBusy || !connection?.connected} onClick={scanInventory}>{inventoryBusy ? "분류 중…" : inventory.length ? "최신 상태로 다시 분류" : "Drive 자료 분류하기"}</button></div>
        {(inventory.length > 0 || inventoryBusy) && <><div className="inventoryProgress">{inventoryBusy && <i />} {inventoryProgress}</div><div className="inventoryFilters"><button className={inventoryFilter === "all" ? "active" : ""} onClick={() => setInventoryFilter("all")}>전체 {inventory.length}</button>{([...Object.keys(roleName), "unclassified"] as InventoryRole[]).map((role) => <button className={inventoryFilter === role ? "active" : ""} key={role} onClick={() => setInventoryFilter(role)}>{role === "unclassified" ? "미분류" : roleName[role]} {inventory.filter((file) => file.role === role).length}</button>)}</div><div className="inventoryList">{inventory.filter((file) => inventoryFilter === "all" || file.role === inventoryFilter).slice(0, 300).map((file) => <div className={file.role === "unclassified" ? "unclassified" : ""} key={file.id}><span>{file.role === "unclassified" ? "미분류" : roleName[file.role]}</span><p><strong>{file.name}</strong><small>{file.path}</small></p><b>{file.reason}</b></div>)}</div></>}
        {!inventory.length && !inventoryBusy && <div className="inventoryEmpty">필요할 때만 Drive 파일의 분류 상태를 확인하세요.</div>}
      </section>
    </details>

    {progress && <div className="notice success"><i /> {progress}</div>}
    {message && <div className="notice success">{message}</div>}
    {error && <div className="notice error preserveLines">{error}</div>}

    {plan && <section className="reviewWorkspace">
      <div className="reviewHeading">
        <div><p className="stepLabel">2. 학교별 변수 선택</p><h3>{plan.week} 작업 설정</h3><p>자동 분석값을 확인하고 학교별 편집 조건을 선택하세요.</p></div>
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
        {choices[job.id] && <div className="variableEditor">
          <label className="rangeField"><span>적용 범위</span><input value={choices[job.id].scope} onChange={(event) => updateChoice(job.id, { scope: event.target.value, rangeConfirmed: false })} /></label>
          <div className="variableChecks" aria-label={`${job.school} 편집 요소`}>
            <label title="클리닉의 필수 구성입니다"><input type="checkbox" checked disabled readOnly />문장배열 (필수)</label>
            <label title="클리닉의 필수 구성입니다"><input type="checkbox" checked disabled readOnly />리테 (필수)</label>
            <label><input type="checkbox" checked={choices[job.id].includeC2} onChange={(event) => updateChoice(job.id, { includeC2: event.target.checked })} />영작배열</label>
            <label><input type="checkbox" checked={choices[job.id].includeAnswers} onChange={(event) => updateChoice(job.id, { includeAnswers: event.target.checked })} />정답지</label>
            <label><input type="checkbox" checked={choices[job.id].includeCover} onChange={(event) => updateChoice(job.id, { includeCover: event.target.checked })} />표지</label>
            <label><input type="checkbox" checked={choices[job.id].excludeFurther} onChange={(event) => updateChoice(job.id, { excludeFurther: event.target.checked })} />Further Reading 제외</label>
          </div>
          <div className="decisionRow">
            <label><input type="checkbox" checked={choices[job.id].allowQuestionOnly} onChange={(event) => updateChoice(job.id, { allowQuestionOnly: event.target.checked })} />정답 자료가 부족하면 문제지만 생성</label>
            <label className={choices[job.id].rangeConfirmed ? "confirmed" : "needsConfirm"}><input type="checkbox" checked={choices[job.id].rangeConfirmed} onChange={(event) => updateChoice(job.id, { rangeConfirmed: event.target.checked })} />이 학교의 범위·예외 확인 완료</label>
          </div>
        </div>}
        <div className="jobBody">
          <div className="materialTable">{(Object.keys(roleName) as Role[]).map((role) => {
            const candidates = job.materials[role];
            return <div className={candidates.length === 1 ? "found" : candidates.length > 1 ? "warn" : "empty"} key={role}>
              <span>{roleName[role]}</span>
              {candidates.length ? <select aria-label={`${job.school} ${roleName[role]} 선택`} value={choices[job.id]?.selected[role] ?? ""} onChange={(event) => updateChoice(job.id, { selected: { ...choices[job.id].selected, [role]: event.target.value } })}>
                <option value="">{candidates.length > 1 ? `후보 ${candidates.length}개 중 선택` : "사용하지 않음"}</option>
                {candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
              </select> : <strong>자료 없음</strong>}
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
        <div><p className="stepLabel">4. 최종 제작</p><h3>선택 완료된 {buildableCount}개 학교</h3><p>확인하지 않은 학교와 필수 자료가 부족한 학교는 자동으로 제외합니다.</p></div>
        <label className="outputChoice"><span>결과물</span><select value={outputMode} onChange={(event) => setOutputMode(event.target.value as "combined" | "separate")}><option value="combined">문제·정답 합본</option><option value="separate">문제지·정답지 별도</option></select></label>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>범위와 자료 현황을 확인했습니다</span></label>
        <button disabled={busy || !confirmed || buildableCount === 0} onClick={generateBuildable}>{busy ? "제작 중…" : `검증된 ${buildableCount}개 PDF 만들기`}</button>
      </div>
      <p className="footnote">‘내용 검수 필요’ 작업은 자동으로 포함하지 않습니다. 정확한 지문·문항 대조가 완료된 뒤 제작해야 합니다.</p>
    </section>}
  </>;
}
