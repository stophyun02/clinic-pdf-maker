import { apiAuthorized, DriveFile, listDriveFiles } from "../../../google-drive";

type Role = "workbook" | "workbookAnswer" | "rete" | "reteAnswer" | "cover";
type Candidate = Pick<DriveFile, "id" | "name" | "path" | "size" | "modifiedTime">;

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

function parseScope(text: string) {
  return text.split(/\n+/).map((line) => line.replace(/^\s*[-*•]+\s*/, "").trim()).filter(Boolean).map((line, index) => {
    const match = line.match(/^([^:：]+)[:：]\s*(.+)$/);
    return match ? { id: index + 1, school: match[1].trim(), scope: match[2].trim() } : { id: index + 1, school: "학교 미확인", scope: line };
  });
}

function classify(file: DriveFile): Role | null {
  const name = normalize(file.name);
  if (!name.endsWith(".pdf")) return null;
  const answer = name.includes("정답");
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

function automationLevel(scope: string) {
  const normalized = normalize(scope);
  const wholeLesson = /(?:교과서)?[^/]*\d+과(?:전체|본문전체)?$/.test(normalized) && !/\d+과.*(?:\d+번|\d+[~-]\d+|본문\d)/.test(normalized);
  return wholeLesson ? "ready" : "review";
}

export async function POST(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const { scope } = await request.json<{ scope?: string }>();
    const rows = parseScope(scope ?? "");
    if (!rows.length) return Response.json({ error: "학교별 범위를 한 줄씩 입력해 주세요." }, { status: 400 });
    const files = await listDriveFiles();
    const roles: Role[] = ["workbook", "workbookAnswer", "rete", "reteAnswer", "cover"];
    const jobs = rows.map((row) => {
      const materials = Object.fromEntries(roles.map((role) => [role, best(files, role, row.school, row.scope)])) as Record<Role, Candidate[]>;
      const missing = roles.filter((role) => materials[role].length === 0);
      const ambiguous = roles.filter((role) => materials[role].length > 1);
      const level = automationLevel(row.scope);
      const status = missing.length ? "missing" : ambiguous.length ? "ambiguous" : level === "review" ? "review" : "ready";
      return { ...row, status, materials, missing, ambiguous, note: level === "review" ? "지문 번호·모의고사 문항처럼 세부 범위가 있어 PDF 내부 대조가 필요합니다." : "단원 전체 범위로 자동 생성할 수 있습니다." };
    });
    return Response.json({ scannedAt: new Date().toISOString(), fileCount: files.length, jobs });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "자료 검색 실패" }, { status: 500 });
  }
}
