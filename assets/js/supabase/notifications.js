// assets/js/supabase/notifications.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate } from './query.js';

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

export async function unreadNotificationCount() {
  const client = requireClient();
  const { count, error } = await client
    .from('notifications')
    .select('*', { count: 'exact', head: true })
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
