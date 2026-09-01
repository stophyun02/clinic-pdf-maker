import { apiAuthorized, DriveFile, listDriveFiles } from "../../../google-drive";

type MaterialRole = "workbook" | "workbookAnswer" | "rete" | "reteAnswer";
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const candidate = (file: DriveFile) => ({ id: file.id, name: file.name, path: file.path, size: file.size, modifiedTime: file.modifiedTime });

function role(file: DriveFile): MaterialRole | null {
  const name = normalize(file.name); const path = normalize(file.path);
  const answer = name.includes("정답") || name.includes("answer");
  const rete = path.includes("리테모음") || name.includes("리테") || name.includes("리뷰테스트") || name.includes("review");
  if (rete) return answer ? "reteAnswer" : "rete";
  if (name.includes("워크북") || name.includes("내지")) return answer ? "workbookAnswer" : "workbook";
  return null;
}

function usefulTokens(value: string) {
  return normalize(value).replace(/워크북|내지|정답지?|수정|완료|각인북스|자료/g, " ").match(/[a-z가-힣]+|\d+/g)?.filter((token) => token.length > 1) ?? [];
}

export async function GET(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const url = new URL(request.url); const school = url.searchParams.get("school")?.trim() ?? "";
    const workbookId = url.searchParams.get("workbookId")?.trim() ?? ""; const scope = url.searchParams.get("scope")?.trim() ?? "";
    if (!school) return Response.json({ error: "학교와 학년을 먼저 선택해 주세요." }, { status: 400 });
    const schoolKey = normalize(school); const files = await listDriveFiles({ force: url.searchParams.get("refresh") === "1" });
    const schoolFiles = files.filter((file) => normalize(file.path).includes(schoolKey));
    const workbooks = schoolFiles.filter((file) => role(file) === "workbook" && normalize(file.path).includes("워크북")).map(candidate);
    const workbookAnswers = schoolFiles.filter((file) => role(file) === "workbookAnswer" && (normalize(file.path).includes("정답") || normalize(file.path).includes("워크북"))).map(candidate);
    let rete: ReturnType<typeof candidate>[] = []; let reteAnswers: ReturnType<typeof candidate>[] = [];
    if (workbookId) {
      const selected = files.find((file) => file.id === workbookId && role(file) === "workbook" && normalize(file.path).includes(schoolKey));
      if (!selected) throw new Error("선택한 워크북이 해당 학교 폴더에 없습니다.");
      const tokens = [...new Set([...usefulTokens(selected.name), ...usefulTokens(scope)])];
      const ranked = files.filter((file) => ["rete", "reteAnswer"].includes(role(file) ?? "") && normalize(file.path).includes("리테모음")).map((file) => ({ file, score: tokens.filter((token) => normalize(file.path).includes(token)).length })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
      const bestQuestion = ranked.find((item) => role(item.file) === "rete")?.score ?? 0;
      const bestAnswer = ranked.find((item) => role(item.file) === "reteAnswer")?.score ?? 0;
      rete = ranked.filter((item) => role(item.file) === "rete" && item.score === bestQuestion).map((item) => candidate(item.file));
      reteAnswers = ranked.filter((item) => role(item.file) === "reteAnswer" && item.score === bestAnswer).map((item) => candidate(item.file));
    }
    return Response.json({ school, workbooks, workbookAnswers, rete, reteAnswers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "자료를 찾지 못했습니다." }, { status: 500 });
  }
}
