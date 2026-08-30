import { apiAuthorized, checkDriveRoots, driveConfigured } from "../../../google-drive";

export async function GET(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!driveConfigured()) return Response.json({ connected: false, fileCount: 0 });
  try {
    const roots = await checkDriveRoots();
    return Response.json({ connected: true, fileCount: roots.length, rootCount: roots.length, rootNames: roots.map((root) => root.name) });
  } catch (error) {
    return Response.json({ connected: false, fileCount: 0, error: error instanceof Error ? error.message : "Drive 연결 확인 실패" });
  }
}
