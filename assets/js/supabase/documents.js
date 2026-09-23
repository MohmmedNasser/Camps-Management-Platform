// assets/js/supabase/documents.js
// Phase 2 §25: metadata only — no file upload (Phase 3/Cloudinary).
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';
import { DOCUMENT_CATEGORIES, labelOf } from '../core/config.js';

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

const DOCUMENT_SELECT =
  '*, member:family_members(full_name), family:families(reference_code), uploader:profiles!documents_uploaded_by_fkey(full_name)';

/**
 * DB row (snake_case, with the member/family/uploader embeds — all real
 * FKs, so PostgREST embeds them directly, unlike family_stats/
 * family_member_facts) -> the exact shape resultsView()/openPreview()/
 * summaryView() in documents.js already read.
 */
function mapDocumentRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    categoryLabel: labelOf(DOCUMENT_CATEGORIES, row.category),
    categoryIcon: (DOCUMENT_CATEGORIES.find((c) => c.value === row.category) || {}).icon || 'folder',
    personName: row.member?.full_name || '—',
    familyId: row.family?.reference_code || '',
    campId: row.camp_id,
    size: row.file_size || 0,
    mime: row.mime_type || '',
    uploadedAt: row.created_at,
    uploaderName: row.uploader?.full_name || '—',
    dataUrl: '',
    // Reuses the EXISTING backendId convention used throughout documents.js:
    // a truthy value already means "this row has a Cloudinary asset,
    // addressable through the Edge Functions by this id." A pending-storage
    // row (no real asset) gets '' so the existing `row.dataUrl ||
    // row.backendId` check disables its download/preview icon unmodified.
    backendId: row.storage_provider === 'cloudinary' ? row.id : '',
  };
}

/**
 * Every document in one camp, unpaginated — the single query behind the
 * real Camp Admin list, its search/category filter and its summary stat
 * (Phase 4.8 spec §4), same convention as getCampFamilies()/
 * getCampDisplacedPersons()/getCampAidDistributions()/
 * getCampRegistrationRequests(). RLS (documents_select_scoped)
 * independently scopes every row to the caller's own camp regardless of
 * the campId argument.
 */
export async function getCampDocuments(campId) {
  const client = requireClient();
  const rows = await run(
    client.from('documents').select(DOCUMENT_SELECT).eq('camp_id', campId).order('created_at', { ascending: false })
  );
  return rows.map(mapDocumentRow);
}
