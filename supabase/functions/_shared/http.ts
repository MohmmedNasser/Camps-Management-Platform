// Response helpers shared by the three document functions. Error bodies are
// deliberately generic (§35): no stack traces, no Postgres/Cloudinary detail,
// no credentials — the frontend's cloudinary.js maps `code` to the same
// Arabic-message convention assets/js/supabase/errors.js already uses.
import { corsHeaders } from './cors.ts';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'payload_too_large'
  | 'unsupported_type'
  | 'database'
  | 'upstream';

export function errorResponse(status: number, code: ErrorCode, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/**
 * A Content-Disposition header value safe for any document name — every
 * name in this app is Arabic (CLAUDE.md: "All visible text is Arabic"), and
 * raw HTTP header values must be Latin-1 ByteStrings. Passing Arabic text
 * straight into `filename="..."` throws `TypeError: Value is not a valid
 * ByteString` when the Response is constructed — caught live during Phase 3
 * verification, since every test/seed document name is Arabic. RFC 6266 /
 * 5987 fixes this with two directives: an ASCII-only `filename` fallback for
 * older clients, and a percent-encoded UTF-8 `filename*` for the rest.
 */
export function contentDisposition(mode: 'inline' | 'attachment', rawName: string): string {
  // Allowlist printable ASCII (also rules out CR/LF header injection), then
  // strip quote/backslash so the quoted-string stays well-formed.
  const asciiFallback = rawName.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_').trim() || 'document';
  const encoded = encodeURIComponent(rawName);
  return `${mode}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
