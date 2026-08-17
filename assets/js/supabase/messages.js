// assets/js/supabase/messages.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'status'];

export async function listInbox({ status, page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('messages').select('*', { count: 'exact' });
  if (status) query = query.eq('status', status);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getMessage(id) {
  const client = requireClient();
  return run(client.from('messages').select('*').eq('id', id).single());
}

/** Only a displaced person may compose (RLS `messages_insert_displaced`). */
export async function sendMessage({ campId, subject, body }) {
  const client = requireClient();
  const userId = await currentUserId();
  return run(
    client
      .from('messages')
      .insert({ sender_id: userId, camp_id: campId, subject, body, status: 'unread' })
      .select()
      .single()
  );
}

export async function markMessageRead(id) {
  const client = requireClient();
  return run(client.from('messages').update({ status: 'read' }).eq('id', id).select().single());
}

export async function replyToMessage(id, reply) {
  const client = requireClient();
  const userId = await currentUserId();
  return run(
    client
      .from('messages')
      .update({ status: 'replied', reply, replied_by: userId, replied_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
  );
}

export async function unreadMessageCount() {
  const client = requireClient();
  const { count, error } = await client
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'unread');
  if (error) throw mapError(error);
  return count;
}
