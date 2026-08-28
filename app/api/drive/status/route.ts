import { apiAuthorized, driveConfigured, listDriveFiles } from "../../../google-drive";

export async function GET(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!driveConfigured()) return Response.json({ connected: false, fileCount: 0 });
  try {
    const files = await listDriveFiles();
    return Response.json({ connected: true, fileCount: files.length, pdfCount: files.filter((file) => file.mimeType === "application/pdf").length });
  } catch (error) {
    return Response.json({ connected: false, fileCount: 0, error: error instanceof Error ? error.message : "Drive 연결 확인 실패" });
  }
}
