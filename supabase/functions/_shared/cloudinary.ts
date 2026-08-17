// Every call to Cloudinary in this project goes through this module. The
// API secret lives only in this Edge Function's environment (a project
// secret — see BACKEND.md's Phase 3 section for the `supabase secrets set`
// command) and never reaches a response body or the frontend.
//
// Signing: Cloudinary's standard Admin/Upload API request signature —
// https://cloudinary.com/documentation/authentication_signatures — sort the
// signable params alphabetically as `name=value`, join with `&`, append the
// API secret, SHA-1 hex digest. Used identically here for upload, the signed
// download fetch and destroy, so there is exactly one signing routine to get
// right rather than three.
//
// NOTE on the download call: Cloudinary's SDKs expose a `private_download_url`
// *helper* that builds a signed link to `{api_base}/v1_1/<cloud>/<resource_type>
// /download`, built with this same generic signature — documented as SDK
// behaviour, not as a standalone REST reference. If Cloudinary ever changes
// this path, the failure mode is a clean 401/404 from Cloudinary (fails
// closed — no file is served to the wrong caller), not a leak; verify this
// specific call first during the live test pass once secrets are configured.

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export function loadCloudinaryConfig(): CloudinaryConfig {
  const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME');
  const apiKey = Deno.env.get('CLOUDINARY_API_KEY');
  const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET');
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary secrets are not configured on this Edge Function.');
  }
  return { cloudName, apiKey, apiSecret };
}

/** §14: predictable folder structure, project terminology, no personal data in the path. */
export const CATEGORY_FOLDERS: Record<string, string> = {
  id_card: 'identity',
  passport: 'identity',
  birth_certificate: 'identity',
  medical_report: 'medical',
  other: 'other',
};

const CLOUDINARY_ROOT = 'camps-platform/documents';

export function folderFor(category: string): string {
  const sub = CATEGORY_FOLDERS[category] ?? CATEGORY_FOLDERS.other;
  return `${CLOUDINARY_ROOT}/${sub}`;
}

/** §12: one centralized limit. Matches the number already shown in ui/upload.js's dropzone hint. */
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

interface TypeSpec {
  ext: string;
  /** Checked against the first bytes of the file, not the client-declared Content-Type (§11). */
  magic: (bytes: Uint8Array) => boolean;
}

export const ALLOWED_TYPES: Record<string, TypeSpec> = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': {
    ext: 'png',
    magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a,
  },
  'image/webp': {
    ext: 'webp',
    magic: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50, // "WEBP"
  },
  'application/pdf': { ext: 'pdf', magic: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 }, // "%PDF"
};

/** Cloudinary treats PDFs as an image resource (page thumbnails) — every allowed type here uses 'image'. */
export const RESOURCE_TYPE = 'image';

export function validateFileType(mimeType: string, bytes: Uint8Array): { ok: true; ext: string } | { ok: false; reason: string } {
  const spec = ALLOWED_TYPES[mimeType];
  if (!spec) return { ok: false, reason: 'unsupported_type' };
  if (bytes.length < 12 || !spec.magic(bytes)) return { ok: false, reason: 'type_mismatch' };
  return { ok: true, ext: spec.ext };
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Cloudinary's generic Admin/Upload API request signature. */
async function signParams(params: Record<string, string | number>, apiSecret: string): Promise<string> {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && String(params[k]) !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return sha1Hex(toSign + apiSecret);
}

export interface CloudinaryUploadResult {
  public_id: string;
  secure_url: string;
  resource_type: string;
  format: string;
  bytes: number;
}

/** Signed upload, type=private so the asset is never reachable by a plain URL (§9, §29). */
export async function uploadToCloudinary(
  config: CloudinaryConfig,
  file: Blob,
  opts: { publicId: string; category: string }
): Promise<CloudinaryUploadResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = folderFor(opts.category);
  const signature = await signParams(
    { folder, public_id: opts.publicId, timestamp, type: 'private' },
    config.apiSecret
  );

  const form = new FormData();
  form.set('file', file);
  form.set('api_key', config.apiKey);
  form.set('timestamp', String(timestamp));
  form.set('signature', signature);
  form.set('public_id', opts.publicId);
  form.set('folder', folder);
  form.set('type', 'private');

  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/${RESOURCE_TYPE}/upload`, {
    method: 'POST',
    body: form,
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`cloudinary upload failed (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
  }
  return body as CloudinaryUploadResult;
}

/** Fetches the raw bytes of a private asset server-side; the browser never sees a Cloudinary URL (§17). */
export async function fetchFromCloudinary(config: CloudinaryConfig, publicId: string): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signParams({ public_id: publicId, timestamp, type: 'private' }, config.apiSecret);
  const qs = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    type: 'private',
    api_key: config.apiKey,
    signature,
  });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/${RESOURCE_TYPE}/download?${qs}`);
  if (!res.ok) {
    throw new Error(`cloudinary download failed (${res.status})`);
  }
  return res;
}

/** Signed destroy. Returns true when the asset is gone (destroyed now, or already absent). */
export async function destroyOnCloudinary(config: CloudinaryConfig, publicId: string): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signParams({ public_id: publicId, timestamp, type: 'private' }, config.apiSecret);

  const form = new FormData();
  form.set('public_id', publicId);
  form.set('timestamp', String(timestamp));
  form.set('signature', signature);
  form.set('api_key', config.apiKey);
  form.set('type', 'private');

  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/${RESOURCE_TYPE}/destroy`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) return false;
  const body = await res.json();
  return body.result === 'ok' || body.result === 'not found';
}
