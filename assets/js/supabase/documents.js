// assets/js/supabase/documents.js
// Phase 2 §25: metadata only — no file upload (Phase 3/Cloudinary).
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'name', 'category'];

export async function listDocuments(filters = {}, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('documents').select('*', { count: 'exact' });
  if (filters.familyId) query = query.eq('family_id', filters.familyId);
  if (filters.familyMemberId) query = query.eq('family_member_id', filters.familyMemberId);
  if (filters.campId) query = query.eq('camp_id', filters.campId);
  if (filters.category) query = query.eq('category', filters.category);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getDocument(id) {
  const client = requireClient();
  return run(client.from('documents').select('*').eq('id', id).single());
}

export async function createDocumentMetadata(doc) {
  const client = requireClient();
  const allowed = [
    'name',
    'category',
    'camp_id',
    'family_id',
    'family_member_id',
    'registration_request_id',
    'original_filename',
    'mime_type',
    'file_size',
  ];
  const body = Object.fromEntries(Object.entries(doc).filter(([k]) => allowed.includes(k)));
  return run(client.from('documents').insert(body).select().single());
}

/** No expiry date field — domain rule 6, unchanged from Phase 1. */
export async function updateDocumentMetadata(id, patch) {
  const client = requireClient();
  const allowed = ['name', 'category'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('documents').update(body).eq('id', id).select().single());
}

export async function deleteDocumentMetadata(id) {
  const client = requireClient();
  await run(client.from('documents').delete().eq('id', id).select().maybeSingle());
}
