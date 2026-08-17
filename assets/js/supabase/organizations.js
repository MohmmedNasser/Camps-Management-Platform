// assets/js/supabase/organizations.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['name', 'created_at'];

export async function listOrganizations({ search, page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('organizations').select('*', { count: 'exact' });
  if (search) query = query.ilike('name', `%${search}%`);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'name');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getOrganization(id) {
  const client = requireClient();
  return run(client.from('organizations').select('*').eq('id', id).single());
}

/** Phone stays optional (domain rule 11) — never marked required here or in a schema. */
export async function createOrganization({ name, responsiblePerson, phone }) {
  const client = requireClient();
  return run(
    client.from('organizations').insert({ name, responsible_person: responsiblePerson, phone }).select().single()
  );
}

export async function updateOrganization(id, patch) {
  const client = requireClient();
  const allowed = ['name', 'responsible_person', 'phone'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('organizations').update(body).eq('id', id).select().single());
}

export async function deleteOrganization(id) {
  const client = requireClient();
  await run(client.from('organizations').delete().eq('id', id).select().maybeSingle());
}
