import { env } from "cloudflare:workers";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  modifiedTime?: string;
  path: string;
};

type DriveConfig = {
  folderIds: string[];
  email: string;
  privateKey: string;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
let fileCache: { files: DriveFile[]; expiresAt: number } | null = null;
let fileLoadPromise: Promise<DriveFile[]> | null = null;
const DRIVE_INDEX_KEY = "system/drive-file-index.json";
const DRIVE_INDEX_TTL = 15 * 60 * 1000;

function config(): DriveConfig | null {
  const values = env as unknown as Record<string, string | undefined>;
  const folderIds = values.GOOGLE_DRIVE_FOLDER_ID?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const email = values.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = values.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  return folderIds.length && email && privateKey ? { folderIds, email, privateKey } : null;
}

function base64Url(bytes: Uint8Array | string) {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemBytes(pem: string) {
  const binary = atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function accessToken(settings: DriveConfig, scope = "https://www.googleapis.com/auth/drive.readonly") {
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: settings.email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(settings.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const assertion = `${header}.${claim}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error("Google Drive 인증에 실패했습니다. 서비스 계정 공유 권한을 확인해 주세요.");
  const payload = await response.json<{ access_token: string; expires_in: number }>();
  tokenCache.set(scope, { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 });
  return payload.access_token;
}

export async function googleCloudAccessToken() {
  const settings = config();
  if (!settings) throw new Error("Google 서비스 계정 연결 설정이 아직 완료되지 않았습니다.");
  return accessToken(settings, "https://www.googleapis.com/auth/cloud-platform");
}

export function driveConfigured() {
  return Boolean(config());
}

export async function checkDriveRoots() {
  const settings = config();
  if (!settings) throw new Error("Google Drive 연결 설정이 아직 완료되지 않았습니다.");
  const roots = [];
  for (const id of settings.folderIds) {
    const response = await driveFetch(`files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`);
    if (!response.ok) throw new Error("공유 폴더를 읽지 못했습니다. 서비스 계정의 뷰어 권한을 확인해 주세요.");
    const folder = await response.json<{ id: string; name: string; mimeType: string }>();
    if (folder.mimeType !== "application/vnd.google-apps.folder") throw new Error("등록된 Drive 주소가 폴더가 아닙니다.");
    roots.push({ id: folder.id, name: folder.name });
  }
  return roots;
}

export async function listDriveFolder(id: string) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error("잘못된 Drive 폴더 식별자입니다.");
  const output: Omit<DriveFile, "path">[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${id}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await driveFetch(`files?${params}`);
    if (!response.ok) throw new Error("Drive 폴더 목록을 읽지 못했습니다.");
    const payload = await response.json<{ nextPageToken?: string; files: Omit<DriveFile, "path">[] }>();
    output.push(...payload.files);
    pageToken = payload.nextPageToken ?? "";
  } while (pageToken);
  return output;
}

const normalizedFolder = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

function schoolFolderKeys(school: string) {
  const exact = normalizedFolder(school);
  const relaxed = exact.replace(/여고(?=\d)/g, "").replace(/고(?=\d)/g, "");
  return [...new Set([exact, relaxed].filter((value) => value.length >= 2))];
}

async function collectFolderFiles(folderId: string, basePath: string) {
  const output: DriveFile[] = [];
  const queue = [{ id: folderId, path: basePath }];
  while (queue.length) {
    const folder = queue.shift()!;
    const items = await listDriveFolder(folder.id);
    for (const item of items) {
      const path = `${folder.path}/${item.name}`;
      if (item.mimeType === "application/vnd.google-apps.folder") queue.push({ id: item.id, path });
      else output.push({ ...item, path });
    }
  }
  return output;
}

/**
 * Finds one school's workbook folder without walking the entire Drive library.
 * Expected hierarchy: 각인북스_자료 > 담당자(학교) > 학교·학년 > 워크북/정답지.
 */
export async function listSchoolWorkbookFiles(school: string) {
  const settings = config();
  if (!settings) throw new Error("Google Drive 연결 설정이 아직 완료되지 않았습니다.");
  const keys = schoolFolderKeys(school);
  const roots = await checkDriveRoots();
  const materialRoots = roots.filter((root) => {
    const name = normalizedFolder(root.name);
    return !name.includes("리테모음") && (name.includes("각인북스") || name.includes("자료"));
  });
  const queue = (materialRoots.length ? materialRoots : roots.filter((root) => !normalizedFolder(root.name).includes("리테모음")))
    .map((root) => ({ id: root.id, path: root.name, depth: 0 }));
  const matches: { id: string; path: string }[] = [];

  while (queue.length) {
    const folder = queue.shift()!;
    const items = await listDriveFolder(folder.id);
    for (const item of items) {
      if (item.mimeType !== "application/vnd.google-apps.folder") continue;
      const path = `${folder.path}/${item.name}`;
      const name = normalizedFolder(item.name);
      if (keys.some((key) => name.includes(key))) matches.push({ id: item.id, path });
      else if (folder.depth < 2) queue.push({ id: item.id, path, depth: folder.depth + 1 });
    }
    if (matches.length) break;
  }

  if (!matches.length) return [];
  const groups = await Promise.all(matches.map((folder) => collectFolderFiles(folder.id, folder.path)));
  return groups.flat();
}

async function driveFetch(path: string, init: RequestInit = {}, base = "https://www.googleapis.com/drive/v3/") {
  const settings = config();
  if (!settings) throw new Error("Google Drive 연결 설정이 아직 완료되지 않았습니다.");
  const token = await accessToken(settings);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function storedDriveIndex() {
  const bucket = (env as unknown as { RETE_FILES?: R2Bucket }).RETE_FILES;
  if (!bucket) return null;
  const object = await bucket.get(DRIVE_INDEX_KEY);
  if (!object) return null;
  const updatedAt = Number(object.customMetadata?.updatedAt ?? 0);
  if (!updatedAt || Date.now() - updatedAt > DRIVE_INDEX_TTL) return null;
  return JSON.parse(await object.text()) as DriveFile[];
}

async function saveDriveIndex(files: DriveFile[]) {
  const bucket = (env as unknown as { RETE_FILES?: R2Bucket }).RETE_FILES;
  if (!bucket) return;
  await bucket.put(DRIVE_INDEX_KEY, JSON.stringify(files), { httpMetadata: { contentType: "application/json" }, customMetadata: { updatedAt: String(Date.now()) } });
}

async function scanDriveFiles(): Promise<DriveFile[]> {
  const settings = config();
  if (!settings) throw new Error("Google Drive 연결 설정이 아직 완료되지 않았습니다.");
  const output: DriveFile[] = [];
  const queue = settings.folderIds.map((id, index) => ({ id, path: settings.folderIds.length > 1 ? `자료실 ${index + 1}` : "" }));
  while (queue.length) {
    const folder = queue.shift()!;
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${folder.id}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await driveFetch(`files?${params}`);
      if (!response.ok) throw new Error("Google Drive 자료 목록을 읽지 못했습니다. 공유 폴더 권한을 확인해 주세요.");
      const payload = await response.json<{ nextPageToken?: string; files: Omit<DriveFile, "path">[] }>();
      for (const file of payload.files) {
        const path = folder.path ? `${folder.path}/${file.name}` : file.name;
        if (file.mimeType === "application/vnd.google-apps.folder") queue.push({ id: file.id, path });
        else output.push({ ...file, path });
      }
      pageToken = payload.nextPageToken ?? "";
    } while (pageToken);
  }
  await saveDriveIndex(output);
  return output;
}

export async function listDriveFiles(options: { force?: boolean } = {}): Promise<DriveFile[]> {
  if (!options.force && fileCache && fileCache.expiresAt > Date.now()) return fileCache.files;
  if (!options.force) {
    const stored = await storedDriveIndex();
    if (stored) { fileCache = { files: stored, expiresAt: Date.now() + DRIVE_INDEX_TTL }; return stored; }
  }
  if (fileLoadPromise) return fileLoadPromise;
  fileLoadPromise = scanDriveFiles().then((files) => { fileCache = { files, expiresAt: Date.now() + DRIVE_INDEX_TTL }; return files; }).finally(() => { fileLoadPromise = null; });
  return fileLoadPromise;
}

export async function downloadDrivePdf(id: string) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error("잘못된 파일 식별자입니다.");
  const response = await driveFetch(`files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
  if (!response.ok) throw new Error("Google Drive PDF를 내려받지 못했습니다.");
  return response;
}

export function apiAuthorized(request: Request) {
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  return Boolean(request.headers.get("oai-authenticated-user-id"));
}
