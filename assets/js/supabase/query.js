// assets/js/supabase/query.js
/** Phase 2 §32/§33: consistent pagination and whitelist-only sorting. */
import { mapError } from './errors.js';

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

/** PostgREST's default `max-rows`: a single response never carries more. */
export const FETCH_BATCH = 1000;
const IN_CHUNK = 100;

/**
 * Every row a query matches, in `FETCH_BATCH`-sized `.range()` requests —
 * so a result larger than PostgREST's row cap is completed rather than
 * silently truncated. `makeQuery()` must return a fresh builder each call.
 * `order` is a list of column names or `[column, ascending]` pairs and must
 * end in a unique key, so batches never overlap or skip when rows change
 * between requests. Any failed batch throws; partial data is never returned.
 */
export function fetchAll(makeQuery, { order, batchSize = FETCH_BATCH } = {}) {
  if (!Array.isArray(order) || !order.length) throw new Error('fetchAll requires an explicit order');
  return (async () => {
    const rows = [];
    for (let from = 0; ; from += batchSize) {
      let query = makeQuery();
      order.forEach((entry) => {
        const [column, ascending = true] = Array.isArray(entry) ? entry : [entry];
        query = query.order(column, { ascending });
      });
      const { data, error } = await query.range(from, from + batchSize - 1);
      if (error) throw mapError(error);
      rows.push(...data);
      if (data.length < batchSize) return rows;
    }
  })();
}

/** `fetchAll` for a keyed lookup, split so the `in.(…)` list never overflows the URL. */
export async function fetchAllIn(makeQuery, column, values, opts) {
  const rows = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK);
    rows.push(...(await fetchAll(() => makeQuery().in(column, chunk), opts)));
  }
  return rows;
}
