// assets/js/supabase/notifications.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, fetchAll } from './query.js';

/** notifications row (snake_case) -> the shape every renderer (page list, dashboard stat via count only, header dropdown) reads. */
export function mapNotificationRow(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    text: item.body,
    createdAt: item.created_at,
    read: item.is_read,
    href: item.href || '',
  };
}

export async function listNotifications({ page, pageSize } = {}) {
  const client = requireClient();
  let query = client.from('notifications').select('*', { count: 'exact' }).order('created_at', { ascending: false });
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

/** Every notification the caller can see (RLS: own only), newest first — beyond `MAX_PAGE_SIZE`. */
export async function listAllNotifications() {
  const client = requireClient();
  return fetchAll(() => client.from('notifications').select('*'), { order: [['created_at', false], ['id', false]] });
}

export async function unreadNotificationCount() {
  const client = requireClient();
  // A plain `count: 'exact'` request, not `head: true`: PostgREST's HEAD
  // response against this project reliably shows as net::ERR_ABORTED in
  // Chromium (reproduced in isolation, unrelated to any concurrent call —
  // the JS-level count still resolves correctly, but the aborted transport
  // is a real, previously-undiscovered bug, unexercised in any real browser
  // before this phase since this function was otherwise unused).
  const { count, error } = await client
    .from('notifications')
    .select('id', { count: 'exact' })
    .eq('is_read', false);
  if (error) throw mapError(error);
  return count;
}

export async function markNotificationRead(id) {
  const client = requireClient();
  return run(
    client.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('id', id).select().single()
  );
}

export async function markNotificationUnread(id) {
  const client = requireClient();
  return run(
    client.from('notifications').update({ is_read: false, read_at: null }).eq('id', id).select().single()
  );
}

export async function markAllNotificationsRead() {
  const client = requireClient();
  const userId = await currentUserId();
  const { error } = await client
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('recipient_id', userId)
    .eq('is_read', false);
  if (error) throw mapError(error);
}
