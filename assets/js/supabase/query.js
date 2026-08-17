// assets/js/supabase/query.js
/** Phase 2 §32/§33: consistent pagination and whitelist-only sorting. */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function paginate(query, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const size = Math.min(Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const p = Math.max(1, Number(page) || 1);
  const from = (p - 1) * size;
  const to = from + size - 1;
  return query.range(from, to);
}

/** `allowedColumns` is the whitelist; `sortBy` outside it silently falls back. */
export function sort(query, { sortBy, sortDir = 'asc' } = {}, allowedColumns, fallback) {
  const column = allowedColumns.includes(sortBy) ? sortBy : fallback;
  return query.order(column, { ascending: sortDir !== 'desc' });
}
