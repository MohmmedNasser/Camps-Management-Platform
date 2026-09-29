// assets/js/supabase/preferences.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run } from './errors.js';

const DEFAULTS = { notifyAid: true, notifyRequests: true, notifyMessages: true, denseTables: false };

const COLUMN_MAP = {
  notifyAid: 'notify_aid',
  notifyRequests: 'notify_requests',
  notifyMessages: 'notify_messages',
  denseTables: 'dense_tables',
};

function mapRow(row) {
  if (!row) return { ...DEFAULTS };
  return {
    notifyAid: row.notify_aid,
    notifyRequests: row.notify_requests,
    notifyMessages: row.notify_messages,
    denseTables: row.dense_tables,
  };
}

/**
 * The signed-in user's own preferences row — replaces `core/store.js`'s
 * mock `preferences.get()`. `private.handle_new_user()` creates one row per
 * account at signup, but this falls back to the same defaults rather than
 * throwing if it's ever missing, same convention as `getOwnProfile()`.
 */
export async function getOwnPreferences() {
  const client = requireClient();
  const userId = await currentUserId();
  if (!userId) return { ...DEFAULTS };
  const row = await run(client.from('user_preferences').select('*').eq('user_id', userId).maybeSingle());
  return mapRow(row);
}

/**
 * camelCase patch -> snake_case columns. RLS (`user_preferences_update_own`)
 * is the actual scoping boundary, so no explicit allow-list is needed beyond
 * mapping to real column names.
 */
export async function updateOwnPreferences(patch) {
  const client = requireClient();
  const userId = await currentUserId();
  const body = Object.fromEntries(
    Object.entries(patch)
      .filter(([key]) => key in COLUMN_MAP)
      .map(([key, value]) => [COLUMN_MAP[key], value])
  );
  const row = await run(
    client.from('user_preferences').update(body).eq('user_id', userId).select().single()
  );
  return mapRow(row);
}
