// assets/js/supabase/camps.js
import { requireClient } from '../core/supabase-client.js';
import { run } from './errors.js';
import { sort } from './query.js';

const SORT_COLUMNS = ['name', 'created_at'];

export async function listCamps({ status, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('camps').select('*');
  if (status) query = query.eq('status', status);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'name');
  return run(query);
}

export async function getCamp(id) {
  const client = requireClient();
  return run(client.from('camps').select('*').eq('id', id).single());
}

export async function createCamp({ name, governorate, city }) {
  const client = requireClient();
  return run(client.from('camps').insert({ name, governorate, city }).select().single());
}

export async function updateCamp(id, patch) {
  const client = requireClient();
  const allowed = ['name', 'governorate', 'city'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('camps').update(body).eq('id', id).select().single());
}

export async function setCampStatus(id, status) {
  const client = requireClient();
  return run(client.from('camps').update({ status }).eq('id', id).select().single());
}
