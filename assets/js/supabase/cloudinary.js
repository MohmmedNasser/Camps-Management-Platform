// assets/js/supabase/cloudinary.js
//
// Phase 3: the only frontend module that knows the three document Edge
// Functions exist. It calls them through the shared client's
// `.functions.invoke()` — never constructs its own client (same rule as
// every other module in this folder) — and never sees a Cloudinary URL or
// credential; both stay server-side (see BACKEND.md's Phase 3 section).
import { requireClient } from '../core/supabase-client.js';
import { DataAccessError, ErrorType } from './errors.js';

const EDGE_ERROR_TYPES = {
  unauthorized: ErrorType.UNAUTHORIZED,
  forbidden: ErrorType.FORBIDDEN,
  not_found: ErrorType.NOT_FOUND,
  validation: ErrorType.VALIDATION,
  payload_too_large: ErrorType.VALIDATION,
  unsupported_type: ErrorType.VALIDATION,
  database: ErrorType.DATABASE,
  upstream: ErrorType.DATABASE,
};

/**
 * Edge Function errors arrive as `{ error: { code, message } }` JSON bodies
 * on the failed response (`error.context` in supabase-js). Mapped through
 * the same DataAccessError / Arabic-message convention as errors.js so the
 * rest of the app's error handling doesn't need a special case for this
 * module.
 */
async function mapFunctionError(error) {
  const context = error?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error?.message) {
        return new DataAccessError(EDGE_ERROR_TYPES[body.error.code] || ErrorType.DATABASE, body.error.message, error);
      }
    } catch {
      // fall through to the generic message below
    }
  }
  return new DataAccessError(ErrorType.DATABASE, 'حدث خطأ غير متوقع، حاول مرة أخرى', error);
}

/**
 * Uploads a file for a family member — matches the current documents.js UI,
 * which always ties a document to a person. `familyId`/`registrationRequestId`
 * exist on the backend (documents.family_id / .registration_request_id) but
 * no page exercises them yet.
 */
export async function uploadDocument({ file, name, category, familyMemberId }) {
  const client = requireClient();
  const form = new FormData();
  form.set('file', file);
  form.set('name', name);
  form.set('category', category);
  if (familyMemberId) form.set('family_member_id', familyMemberId);

  const { data, error } = await client.functions.invoke('documents-upload', { body: form });
  if (error) throw await mapFunctionError(error);
  return data.document;
}

/** A Blob for the document's file. Used for both preview and download — §18: identical authorization path for both. */
export async function getDocumentBlob(id, { mode = 'inline' } = {}) {
  const client = requireClient();
  const { data, error, response } = await client.functions.invoke('documents-access', { body: { id, mode } });
  if (error) throw await mapFunctionError(error);
  // The Edge Function always answers application/octet-stream (the only
  // Content-Type supabase-js parses into a Blob rather than mangling binary
  // bytes as UTF-8 text — see documents-access/index.ts) and carries the
  // real MIME type as a header instead. Re-type the Blob with it here.
  const mime = response?.headers?.get('X-Document-Mime') || data.type;
  return mime && mime !== data.type ? new Blob([data], { type: mime }) : data;
}

export async function deleteDocumentAsset(id) {
  const client = requireClient();
  const { error } = await client.functions.invoke('documents-delete', { body: { id } });
  if (error) throw await mapFunctionError(error);
}
