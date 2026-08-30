import { apiAuthorized, listDriveCovers, uploadDriveCover } from "../../../google-drive";

export async function GET(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    return Response.json({ covers: await listDriveCovers() });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "표지 목록을 읽지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "표지 PDF를 선택해 주세요." }, { status: 400 });
    if (!file.name.toLowerCase().endsWith(".pdf") || file.type !== "application/pdf") return Response.json({ error: "PDF 표지만 저장할 수 있습니다." }, { status: 400 });
    if (file.size > 30 * 1024 * 1024) return Response.json({ error: "표지는 30MB 이하만 저장할 수 있습니다." }, { status: 400 });
    const saved = await uploadDriveCover(file.name, new Uint8Array(await file.arrayBuffer()));
    return Response.json({ cover: saved });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "표지 저장에 실패했습니다." }, { status: 500 });
  }
}
