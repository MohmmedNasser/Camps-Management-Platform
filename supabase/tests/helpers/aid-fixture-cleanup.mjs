// supabase/tests/helpers/aid-fixture-cleanup.mjs
/**
 * Phase 4.26: cleanup for tests that create aid distributions.
 *
 * Inserting into aid_distribution_families fires the Phase 4.20 trigger
 * (private.notify_aid_beneficiary_family), which writes one notification per
 * account linked to each beneficiary family. Those rows carry no reference to
 * the distribution, and deleting the distribution does NOT delete them, so a
 * test that only deletes its distribution leaks notifications.
 *
 * Strategy (no production change): snapshot the ids that exist before the
 * fixture is created, and afterwards remove only rows that
 *   1. did not exist in the snapshot, AND
 *   2. carry the aid-trigger's exact signature (title + href).
 * The id-diff is the identity; the signature is a second guard so a
 * concurrent unrelated notification is never removed. A message string alone
 * is never used as the identity.
 *
 * Every operation is awaited and its `error` is checked; cleanup failures
 * throw so they cannot be missed.
 */

export const AID_NOTIFICATION_TITLE = 'تمت إضافة مساعدة جديدة إلى ملفك';
export const AID_NOTIFICATION_HREF = 'aid.html';

const PAGE = 1000;

async function readAllIds(service, table) {
  const ids = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service.from(table).select('id').order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`snapshot of ${table} failed: ${error.message}`);
    ids.push(...data.map((r) => r.id));
    if (data.length < PAGE) return new Set(ids);
  }
}

/** Capture what exists now. Call BEFORE creating any aid fixture. */
export async function snapshotAidState(service) {
  return {
    notificationIds: await readAllIds(service, 'notifications'),
    distributionIds: await readAllIds(service, 'aid_distributions'),
  };
}

/**
 * Remove everything created since `snapshot`: the notifications carrying the aid-trigger signature and,
 * unless `keepDistributions` is set, any distribution whose id is new AND whose `distributed_on` is one of
 * `fixtureDates` (when given). Idempotent; returns what was removed.
 */
export async function cleanupAidFixture(service, snapshot, { fixtureDates = null, keepDistributions = false } = {}) {
  const removed = { distributions: [], notifications: [] };

  if (!keepDistributions) {
    const { data, error } = await service.from('aid_distributions').select('id, distributed_on');
    if (error) throw new Error(`cleanup: listing distributions failed: ${error.message}`);
    const stray = data
      .filter((d) => !snapshot.distributionIds.has(d.id))
      .filter((d) => !fixtureDates || fixtureDates.includes(d.distributed_on))
      .map((d) => d.id);
    if (stray.length) {
      const { error: delError } = await service.from('aid_distributions').delete().in('id', stray);
      if (delError) throw new Error(`cleanup: deleting distributions failed: ${delError.message}`);
      removed.distributions = stray;
    }
  }

  const { data: notes, error: noteError } = await service
    .from('notifications')
    .select('id')
    .eq('title', AID_NOTIFICATION_TITLE)
    .eq('href', AID_NOTIFICATION_HREF);
  if (noteError) throw new Error(`cleanup: listing notifications failed: ${noteError.message}`);
  const added = notes.filter((n) => !snapshot.notificationIds.has(n.id)).map((n) => n.id);
  if (added.length) {
    const { error: delError } = await service.from('notifications').delete().in('id', added);
    if (delError) throw new Error(`cleanup: deleting notifications failed: ${delError.message}`);
    removed.notifications = added;
  }
  return removed;
}

/** Full state of the seed notifications, for exact before/after comparison (id, recipient, read state, content). */
export async function notificationFingerprint(service) {
  const { data, error } = await service
    .from('notifications')
    .select('id, recipient_id, type, title, body, href, is_read, read_at, created_at')
    .order('id');
  if (error) throw new Error(`fingerprint failed: ${error.message}`);
  return JSON.stringify(data);
}
