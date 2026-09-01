import { apiAuthorized, googleCloudAccessToken } from "../../google-drive";

type Vertex = { x?: number; y?: number };
type VisionWord = { symbols?: { text?: string }[]; boundingBox?: { vertices?: Vertex[] } };

export async function POST(request: Request) {
  if (!apiAuthorized(request)) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json<{ image?: string }>();
    if (!body.image || body.image.length > 12_000_000) return Response.json({ error: "OCR 이미지가 없거나 너무 큽니다." }, { status: 400 });
    const token = await googleCloudAccessToken();
    const response = await fetch("https://vision.googleapis.com/v1/images:annotate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ image: { content: body.image }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }], imageContext: { languageHints: ["ko", "en"] } }] }),
    });
    const payload = await response.json<{ responses?: { error?: { message?: string }; fullTextAnnotation?: { text?: string; pages?: { width?: number; height?: number; blocks?: { paragraphs?: { words?: VisionWord[] }[] }[] }[] } }[] }>();
    const result = payload.responses?.[0];
    if (!response.ok || result?.error) throw new Error(result?.error?.message ?? "Google OCR 요청에 실패했습니다.");
    const page = result?.fullTextAnnotation?.pages?.[0];
    const width = page?.width ?? 1; const height = page?.height ?? 1;
    const tokens = (page?.blocks ?? []).flatMap((block) => block.paragraphs ?? []).flatMap((paragraph) => paragraph.words ?? []).map((word) => {
      const vertices = word.boundingBox?.vertices ?? [];
      const x = Math.min(...vertices.map((vertex) => vertex.x ?? 0));
      const y = Math.min(...vertices.map((vertex) => vertex.y ?? 0));
      return { text: (word.symbols ?? []).map((symbol) => symbol.text ?? "").join(""), x: x / width, y: y / height };
    }).filter((token) => token.text);
    return Response.json({ text: result?.fullTextAnnotation?.text ?? "", tokens });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? `이미지형 PDF OCR 실패: ${error.message}` : "이미지형 PDF OCR 실패" }, { status: 502 });
  }
}
