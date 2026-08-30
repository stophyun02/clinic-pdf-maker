import { apiAuthorized, checkDriveRoots, listDriveFolder } from "../../../google-drive";

export async function GET(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const folderId = new URL(request.url).searchParams.get("folderId");
    if (!folderId) return Response.json({ roots: await checkDriveRoots() });
    return Response.json({ items: await listDriveFolder(folderId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "자료실을 읽지 못했습니다." }, { status: 500 });
  }
}
