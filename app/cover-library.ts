import { env } from "cloudflare:workers";

const tableSql = `CREATE TABLE IF NOT EXISTS clinic_cover_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

async function ready() { await env.DB.prepare(tableSql).run(); }

export async function listStoredCovers() {
  await ready();
  const rows = await env.DB.prepare("SELECT id, filename, object_key, size, created_at FROM clinic_cover_files ORDER BY created_at DESC").all<{
    id: number; filename: string; object_key: string; size: number; created_at: string;
  }>();
  return rows.results;
}

export async function storeCover(file: File) {
  await ready();
  const key = `covers/${crypto.randomUUID()}.pdf`;
  await env.RETE_FILES.put(key, file.stream(), { httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename: file.name } });
  const result = await env.DB.prepare("INSERT INTO clinic_cover_files (filename, object_key, size) VALUES (?, ?, ?) RETURNING id, filename, size, created_at")
    .bind(file.name, key, file.size).first<{ id: number; filename: string; size: number; created_at: string }>();
  return result;
}

export async function readStoredCover(id: number) {
  await ready();
  const row = await env.DB.prepare("SELECT filename, object_key FROM clinic_cover_files WHERE id=?").bind(id).first<{ filename: string; object_key: string }>();
  if (!row) return null;
  const object = await env.RETE_FILES.get(row.object_key);
  return object ? { row, object } : null;
}
