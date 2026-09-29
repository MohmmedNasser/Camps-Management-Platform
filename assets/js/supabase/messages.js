// assets/js/supabase/messages.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';

const MESSAGE_SELECT =
  'id, sender_id, camp_id, recipient_role, recipient_id, subject, body, status, reply, ' +
  'replied_by, replied_at, created_at, updated_at, ' +
  'sender:profiles!messages_sender_id_fkey(full_name, family_member_id)';

/** DB row (snake_case, with the sender embed) -> the shape every page reads. */
function mapMessageRow(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    campId: row.camp_id,
    recipientRole: row.recipient_role,
    recipientId: row.recipient_id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    reply: row.reply || '',
    repliedBy: row.replied_by,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
    senderName: row.sender?.full_name || 'مستخدم محذوف',
    senderFamilyMemberId: row.sender?.family_member_id || null,
  };
}

/**
 * Every message addressed to one camp — the real Camp Admin inbox
 * (messages.html). RLS (`messages_select_scoped`) independently scopes rows
 * to the caller's own camp regardless of this argument, same convention as
 * `getCampFamilies()`/`getCampDisplacedPersons()`/`getCampAidDistributions()`.
 */
export async function getCampMessages(campId) {
  const client = requireClient();
  const rows = await run(
    client.from('messages').select(MESSAGE_SELECT).eq('camp_id', campId).order('created_at', { ascending: false })
  );
  return rows.map(mapMessageRow);
}

/** Every message platform-wide — the Super Admin view. RLS's `is_super_admin()`
 *  branch is what actually removes the camp boundary here. */
export async function getAllMessages() {
  const client = requireClient();
  const rows = await run(client.from('messages').select(MESSAGE_SELECT).order('created_at', { ascending: false }));
  return rows.map(mapMessageRow);
}

/** A displaced user's own sent messages ("رسائلي"). RLS restricts SELECT to
 *  `sender_id = auth.uid()` for a non-admin caller. */
export async function getOwnMessages() {
  const client = requireClient();
  const userId = await currentUserId();
  if (!userId) return [];
  const rows = await run(
    client.from('messages').select(MESSAGE_SELECT).eq('sender_id', userId).order('created_at', { ascending: false })
  );
  return rows.map(mapMessageRow);
}

/**
 * One message by id. Returns null for a nonexistent id or one RLS hides
 * (another camp/another sender) — same convention as
 * `getRegistrationRequest()`/`getDisplacedPerson()`.
 */
export async function getMessage(id) {
  const client = requireClient();
  const row = await run(client.from('messages').select(MESSAGE_SELECT).eq('id', id).maybeSingle());
  return row ? mapMessageRow(row) : null;
}

/**
 * Displaced-only (`messages_insert_displaced`). The RLS insert policy also
 * requires `status = 'unread'` and `reply is null`, which are simply the
 * column defaults, so they are left unset here rather than duplicated.
 */
export async function createMessage({ campId, subject, body }) {
  const client = requireClient();
  const userId = await currentUserId();
  const row = await run(
    client
      .from('messages')
      .insert({ sender_id: userId, camp_id: campId, subject, body })
      .select(MESSAGE_SELECT)
      .single()
  );
  return mapMessageRow(row);
}

/**
 * Admin reply (`messages_update_admin`: Super Admin, or the Camp Admin of
 * this message's own camp). `replied_by`/`replied_at`/`status` move together
 * — `messages_reply_complete`/`messages_replied_status` both check that a
 * non-null reply always carries them.
 */
export async function replyToMessage(id, replyText) {
  const client = requireClient();
  const userId = await currentUserId();
  const row = await run(
    client
      .from('messages')
      .update({ reply: replyText, replied_by: userId, replied_at: new Date().toISOString(), status: 'replied' })
      .eq('id', id)
      .select(MESSAGE_SELECT)
      .single()
  );
  return mapMessageRow(row);
}

/** Marks an unread message read once an admin opens it (`messages_update_admin`). */
export async function markMessageRead(id) {
  const client = requireClient();
  await run(client.from('messages').update({ status: 'read' }).eq('id', id).select().maybeSingle());
}

/**
 * The sidebar's unread-message badge — Camp Admin/Super Admin only, same as
 * the mock's `unreadMessageCount()` (a displaced person's own sent messages
 * are never "unread" from their own point of view). RLS scopes the count to
 * the caller's own camp (or every camp for a Super Admin) with no argument
 * needed.
 */
export async function getUnreadMessageCount() {
  const client = requireClient();
  const { count, error } = await client
    .from('messages')
    .select('id', { count: 'exact' })
    .eq('status', 'unread');
  if (error) throw mapError(error);
  return count || 0;
}
