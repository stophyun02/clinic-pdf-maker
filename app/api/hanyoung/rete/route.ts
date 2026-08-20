import { env } from "cloudflare:workers";

const tableSql = `CREATE TABLE IF NOT EXISTS hanyoung_rete_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question','answer')),
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(year, month, kind)
)`;

async function ready() { await env.DB.prepare(tableSql).run(); }

export async function GET(request: Request) {
  await ready();
  const url = new URL(request.url);
  const year = Number(url.searchParams.get("year"));
  const month = Number(url.searchParams.get("month"));
  const kind = url.searchParams.get("kind");
  if (year && month && (kind === "question" || kind === "answer")) {
    const row = await env.DB.prepare("SELECT object_key, filename FROM hanyoung_rete_files WHERE year=? AND month=? AND kind=?")
      .bind(year, month, kind).first<{ object_key: string; filename: string }>();
    if (!row) return Response.json({ error: "등록된 리테 파일이 없습니다." }, { status: 404 });
    const object = await env.RETE_FILES.get(row.object_key);
    if (!object) return Response.json({ error: "저장 파일을 찾지 못했습니다." }, { status: 404 });
    return new Response(object.body, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}` } });
  }
  const rows = await env.DB.prepare("SELECT year, month, kind, filename, size, created_at FROM hanyoung_rete_files ORDER BY year DESC, month DESC, kind").all();
  return Response.json({ files: rows.results });
}

export async function POST(request: Request) {
  await ready();
  const form = await request.formData();
  const file = form.get("file");
  const year = Number(form.get("year"));
  const month = Number(form.get("month"));
  const kind = form.get("kind");
  if (!(file instanceof File) || file.type !== "application/pdf" || !year || month < 1 || month > 12 || (kind !== "question" && kind !== "answer")) {
    return Response.json({ error: "연도·월·문제/정답 구분을 확인해 주세요." }, { status: 400 });
  }
  const key = `hanyoung/${year}-${String(month).padStart(2, "0")}/${kind}.pdf`;
  await env.RETE_FILES.put(key, file.stream(), { httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename: file.name } });
  await env.DB.prepare(`INSERT INTO hanyoung_rete_files (year, month, kind, filename, object_key, size)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(year, month, kind) DO UPDATE SET filename=excluded.filename, object_key=excluded.object_key, size=excluded.size, created_at=CURRENT_TIMESTAMP`)
    .bind(year, month, kind, file.name, key, file.size).run();
  return Response.json({ ok: true });
}
