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

async function driveFetch(path: string, init: RequestInit = {}, base = "https://www.googleapis.com/drive/v3/") {
  const settings = config();
  if (!settings) throw new Error("Google Drive 연결 설정이 아직 완료되지 않았습니다.");
  const token = await accessToken(settings);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

export async function listDriveFiles(): Promise<DriveFile[]> {
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
  return output;
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
