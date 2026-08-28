import { apiAuthorized, downloadDrivePdf } from "../../../google-drive";

export async function GET(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    const response = await downloadDrivePdf(id);
    return new Response(response.body, { headers: { "content-type": "application/pdf", "cache-control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "파일 불러오기 실패" }, { status: 400 });
  }
}
