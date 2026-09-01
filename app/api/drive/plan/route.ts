import { apiAuthorized, DriveFile, listDriveFiles } from "../../../google-drive";
import { listStoredCovers } from "../../../cover-library";

type Role = "workbook" | "workbookAnswer" | "rete" | "reteAnswer" | "cover";
type Candidate = Pick<DriveFile, "id" | "name" | "path" | "size" | "modifiedTime">;

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const roles: Role[] = ["workbook", "workbookAnswer", "rete", "reteAnswer", "cover"];

function parseScope(text: string) {
  let week = "주차 미지정";
  const jobs: { id: number; school: string; scope: string; options: { excludeC2: boolean; excludeFurther: boolean } }[] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.replace(/^\s*[-*•]+\s*/, "").trim();
    if (!line) continue;
    const weekMatch = line.match(/<?\s*(\d+)\s*주차\s*>?/);
    if (weekMatch && !line.includes(":")) { week = `${weekMatch[1]}주차`; continue; }
    if (/^<?\s*고[12]\s*>?$/.test(line)) continue;
    const match = line.match(/^([^:：]+)[:：]\s*(.+)$/);
    const school = match?.[1].replace(/[*_]/g, "").trim() ?? "학교 미확인";
    const scope = match?.[2].trim() ?? line;
    jobs.push({
      id: jobs.length + 1,
      school,
      scope,
      options: {
        excludeC2: /(영작\s*배열\s*[xX×]|영작\s*배열\s*제외)/.test(scope),
        excludeFurther: /(further\s*reading\s*[xX×]|further\s*reading\s*제외)/i.test(scope),
      },
    });
  }
  return { week, jobs };
}

function classify(file: DriveFile): Role | null {
  const name = normalize(file.name);
  if (!name.endsWith(".pdf")) return null;
  const answer = name.includes("정답") || name.includes("answer");
  const rete = name.includes("리테") || name.includes("리뷰테스트") || name.includes("review");
  if (name.includes("표지")) return "cover";
  if (rete) return answer ? "reteAnswer" : "rete";
  if (name.includes("워크북") || name.includes("내지")) return answer ? "workbookAnswer" : "workbook";
  return null;
}

function scopeTokens(scope: string) {
  return normalize(scope).match(/[a-z가-힣]+|\d+/g)?.filter((token) => token.length > 1 || /^\d+$/.test(token)) ?? [];
}

function score(file: DriveFile, school: string, scope: string) {
  const path = normalize(file.path);
  let value = path.includes(normalize(school)) ? 100 : 0;
  for (const token of scopeTokens(scope)) if (path.includes(token)) value += /^\d+$/.test(token) ? 3 : 8;
  return value;
}

function best(files: DriveFile[], role: Role, school: string, scope: string): Candidate[] {
  const ranked = files.filter((file) => classify(file) === role).map((file) => ({ file, score: score(file, school, scope) })).filter((item) => item.score >= 100).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  if (!ranked.length) return [];
  const top = ranked[0].score;
  return ranked.filter((item) => item.score === top).map(({ file }) => ({ id: file.id, name: file.name, path: file.path, size: file.size, modifiedTime: file.modifiedTime }));
}

function needsContentReview(scope: string) {
  return /\d+번|\d+[~-]\d+|본문\d|지문|모의고사|마더텅|올림포스|올포/.test(normalize(scope));
}

export async function POST(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const { scope, selectedWorkbooks = [] } = await request.json<{ scope?: string; selectedWorkbooks?: { jobId: number; fileId: string }[] }>();
    const parsed = parseScope(scope ?? "");
    if (!parsed.jobs.length) return Response.json({ error: "학교별 범위를 한 줄씩 입력해 주세요." }, { status: 400 });
    const files = await listDriveFiles();
    const storedCovers = await listStoredCovers();
    const jobs = parsed.jobs.map((row) => {
      const materials = Object.fromEntries(roles.map((role) => [role, best(files, role, row.school, row.scope)])) as Record<Role, Candidate[]>;
      const preferred = selectedWorkbooks.find((selection) => selection.jobId === row.id)?.fileId;
      if (preferred) {
        const selected = files.find((file) => file.id === preferred && classify(file) === "workbook" && normalize(file.path).includes(normalize(row.school)));
        if (!selected) throw new Error(`${row.school}: 선택한 교과서 파일이 현재 학교 자료실과 일치하지 않습니다.`);
        materials.workbook = [{ id: selected.id, name: selected.name, path: selected.path, size: selected.size, modifiedTime: selected.modifiedTime }];
      }
      const savedForSchool = storedCovers.filter((cover) => normalize(cover.filename).includes(normalize(row.school))).map((cover) => ({
        id: `cover:${cover.id}`, name: cover.filename, path: "사이트 표지 자료실", size: String(cover.size), modifiedTime: cover.created_at,
      }));
      if (savedForSchool.length) materials.cover = savedForSchool;
      const missing = roles.filter((role) => materials[role].length === 0);
      const ambiguous = roles.filter((role) => materials[role].length > 1);
      const questionMaterialsReady = materials.workbook.length === 1 && materials.rete.length === 1;
      const answerMaterialsReady = materials.workbookAnswer.length === 1 && materials.reteAnswer.length === 1;
      const contentReview = needsContentReview(row.scope);
      let status: "ready" | "questionReady" | "missing" | "ambiguous" | "review" = "ready";
      if (ambiguous.length) status = "ambiguous";
      else if (!questionMaterialsReady) status = "missing";
      else if (contentReview) status = "review";
      else if (!answerMaterialsReady) status = "questionReady";
      const checks = [
        { label: "문제 자료", state: questionMaterialsReady ? "pass" : "fail" },
        { label: "정답 자료", state: answerMaterialsReady ? "pass" : "warn" },
        { label: "범위 세부 대조", state: contentReview ? "review" : "pass" },
        { label: "영작배열", state: row.options.excludeC2 ? "excluded" : "include" },
      ];
      const note = status === "ready" ? "자료 구성이 명확합니다. PDF 내부 구조 검증 후 완성본을 생성합니다."
        : status === "questionReady" ? "정답 자료가 부족합니다. 클리닉 문제지만 생성할 수 있습니다."
        : status === "review" ? "지문·문항 범위가 있어 원문과 리테 본문 대조 후 승인해야 합니다."
        : status === "ambiguous" ? "같은 조건의 파일이 여러 개입니다. 자동 선택하지 않았습니다."
        : "클리닉 문제 제작에 필요한 원본 또는 리테가 없습니다.";
      return { ...row, status, materials, missing, ambiguous, checks, note };
    });
    const counts = Object.fromEntries(["ready", "questionReady", "review", "missing", "ambiguous"].map((status) => [status, jobs.filter((job) => job.status === status).length]));
    return Response.json({ scannedAt: new Date().toISOString(), fileCount: files.length, week: parsed.week, counts, jobs });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "자료 검색 실패" }, { status: 500 });
  }
}
