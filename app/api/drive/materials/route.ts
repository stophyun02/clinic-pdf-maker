import { apiAuthorized, listDriveFiles } from "../../../google-drive";

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

export async function GET(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const school = new URL(request.url).searchParams.get("school")?.trim() ?? "";
    if (!school) return Response.json({ error: "학교와 학년을 먼저 선택해 주세요." }, { status: 400 });
    const schoolKey = normalize(school);
    const files = await listDriveFiles();
    const workbooks = files.filter((file) => {
      const name = normalize(file.name); const path = normalize(file.path);
      const pdf = file.mimeType === "application/pdf" || name.endsWith(".pdf");
      const workbook = name.includes("워크북") || name.includes("내지");
      const answer = name.includes("정답") || name.includes("answer");
      return pdf && workbook && !answer && path.includes(schoolKey);
    }).map((file) => ({ id: file.id, name: file.name, path: file.path, size: file.size, modifiedTime: file.modifiedTime }));
    return Response.json({ school, workbooks });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "교과서 자료를 찾지 못했습니다." }, { status: 500 });
  }
}
