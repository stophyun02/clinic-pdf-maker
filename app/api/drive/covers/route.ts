import { apiAuthorized } from "../../../google-drive";
import { listStoredCovers, readStoredCover, storeCover } from "../../../cover-library";

export async function GET(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (id) {
      const stored = await readStoredCover(id);
      if (!stored) return Response.json({ error: "저장된 표지를 찾지 못했습니다." }, { status: 404 });
      return new Response(stored.object.body, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(stored.row.filename)}` } });
    }
    const covers = (await listStoredCovers()).map((cover) => ({ id: String(cover.id), name: cover.filename, size: String(cover.size), modifiedTime: cover.created_at }));
    return Response.json({ covers });
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
    const saved = await storeCover(file);
    return Response.json({ cover: { id: String(saved?.id), name: saved?.filename, size: String(saved?.size ?? file.size), modifiedTime: saved?.created_at } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "표지 저장에 실패했습니다." }, { status: 500 });
  }
}
