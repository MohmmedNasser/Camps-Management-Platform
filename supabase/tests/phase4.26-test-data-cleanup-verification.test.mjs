// supabase/tests/phase4.26-test-data-cleanup-verification.test.mjs
/**
 * Phase 4.26: proves the aid-fixture cleanup helper leaves the database exactly as it found it —
 * including the notifications the Phase 4.20 trigger writes as a side effect — on the success path,
 * the failure path, and across repeated runs. Seed notifications are compared field-by-field.
 *
 *   cd supabase && npm run test:phase4.26-test-data-cleanup-verification
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  AID_NOTIFICATION_TITLE,
  AID_NOTIFICATION_HREF,
  snapshotAidState,
  cleanupAidFixture,
  notificationFingerprint,
} from './helpers/aid-fixture-cleanup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(HERE, '../../.env'));

function loadDotEnv(path) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
}

function required(...names) {
  for (const name of names) if (process.env[name]) return process.env[name];
  throw new Error(`Missing ${names.join(' or ')}. Copy .env.example to .env and fill it in.`);
}

const PASSWORD = '123456';
const FIXTURE_DATE = '2026-01-15';

test('Phase 4.26 aid-fixture cleanup leaves no distributions or notifications behind', async (t) => {
  const url = required('SUPABASE_URL');
  const service = createClient(url, required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'));
  const admin = createClient(url, required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'));
  const { error: signInError } = await admin.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
  assert.equal(signInError, null, signInError?.message);

  const { data: me } = await admin.from('profiles').select('camp_id').eq('id', (await admin.auth.getUser()).data.user.id).single();
  const { data: org } = await service.from('organizations').select('id').limit(1).single();
  // Beneficiary: every family in the admin's camp that has an activated account, so the trigger provably fires.
  const { data: linked } = await service.from('profiles').select('family_member_id').not('family_member_id', 'is', null);
  const { data: members } = await service
    .from('family_members')
    .select('id, family_id, camp_id')
    .in('id', linked.map((p) => p.family_member_id))
    .eq('camp_id', me.camp_id);
  const familyIds = [...new Set(members.map((m) => m.family_id))];
  assert.ok(familyIds.length > 0, 'the admin camp has at least one family with an activated account');

  const seedBefore = await notificationFingerprint(service);
  const { count: aidBefore } = await service.from('aid_distributions').select('id', { count: 'exact', head: true });

  async function createFixture() {
    const created = await admin.rpc('create_aid_distribution', {
      p_organization_id: org.id,
      p_camp_id: me.camp_id,
      p_distributed_on: FIXTURE_DATE,
      p_aid_type_codes: ['food'],
      p_family_ids: familyIds,
      p_all_families_selected: false,
    });
    assert.equal(created.error, null, created.error?.message);
    return created.data;
  }

  async function newAidNotifications(snapshot) {
    const { data, error } = await service.from('notifications').select('id').eq('title', AID_NOTIFICATION_TITLE).eq('href', AID_NOTIFICATION_HREF);
    assert.equal(error, null, error?.message);
    return data.filter((n) => !snapshot.notificationIds.has(n.id)).map((n) => n.id);
  }

  try {
    await t.test('the fixture really does generate notifications, and cleanup removes the distribution and every one of them', async () => {
      const snapshot = await snapshotAidState(service);
      let distributionId = null;
      let generated = [];
      try {
        distributionId = await createFixture();
        generated = await newAidNotifications(snapshot);
        assert.ok(generated.length > 0, 'the Phase 4.20 trigger produced notifications for the fixture');
      } finally {
        const removed = await cleanupAidFixture(service, snapshot, { fixtureDates: [FIXTURE_DATE] });
        if (distributionId) assert.deepEqual(removed.distributions, [distributionId]);
        assert.deepEqual([...removed.notifications].sort(), [...generated].sort());
      }
      const { count: distLeft } = await service.from('aid_distributions').select('id', { count: 'exact', head: true }).eq('id', distributionId);
      assert.equal(distLeft, 0, 'fixture distribution removed');
      const { count: junctionLeft } = await service.from('aid_distribution_families').select('distribution_id', { count: 'exact', head: true }).eq('distribution_id', distributionId);
      assert.equal(junctionLeft, 0, 'fixture junction rows removed');
      assert.deepEqual(await newAidNotifications(snapshot), [], 'no notification created by the fixture remains');
      assert.equal(await notificationFingerprint(service), seedBefore, 'every notification field of every seed row is unchanged');
    });

    await t.test('repeating the lifecycle starts from the same baseline and ends on it', async () => {
      const baselines = [];
      for (let run = 0; run < 2; run += 1) {
        const snapshot = await snapshotAidState(service);
        baselines.push(await notificationFingerprint(service));
        try {
          await createFixture();
        } finally {
          await cleanupAidFixture(service, snapshot, { fixtureDates: [FIXTURE_DATE] });
        }
      }
      assert.equal(baselines[0], baselines[1], 'second run began from the first run’s baseline');
      assert.equal(await notificationFingerprint(service), baselines[0], 'and the database ended on it');
    });

    await t.test('failure path: an assertion failing after creation still cleans up (finally)', async () => {
      const snapshot = await snapshotAidState(service);
      let thrown = null;
      try {
        try {
          await createFixture();
          throw new Error('intentional failure after fixture creation');
        } finally {
          await cleanupAidFixture(service, snapshot, { fixtureDates: [FIXTURE_DATE] });
        }
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown?.message, 'intentional failure after fixture creation', 'the original failure still surfaces');
      assert.deepEqual(await newAidNotifications(snapshot), []);
      const { count } = await service.from('aid_distributions').select('id', { count: 'exact', head: true });
      assert.equal(count, aidBefore, 'no distribution left behind');
    });

    await t.test('cleanup is idempotent and tolerates an already-deleted fixture', async () => {
      const snapshot = await snapshotAidState(service);
      const id = await createFixture();
      await service.from('aid_distributions').delete().eq('id', id); // e.g. the UI already deleted it
      const first = await cleanupAidFixture(service, snapshot, { fixtureDates: [FIXTURE_DATE] });
      assert.deepEqual(first.distributions, []);
      assert.ok(first.notifications.length > 0, 'notifications outlive their distribution and are still removed');
      const second = await cleanupAidFixture(service, snapshot, { fixtureDates: [FIXTURE_DATE] });
      assert.deepEqual(second, { distributions: [], notifications: [] });
    });

    await t.test('cleanup never touches rows that pre-date the snapshot, even with the same signature', async () => {
      const seedAid = (await service.from('notifications').select('id').eq('title', AID_NOTIFICATION_TITLE)).data;
      assert.ok(seedAid.length > 0, 'the database has pre-existing aid notifications');
      const snapshot = await snapshotAidState(service);
      const removed = await cleanupAidFixture(service, snapshot, { fixtureDates: [FIXTURE_DATE] });
      assert.deepEqual(removed, { distributions: [], notifications: [] });
      assert.equal(await notificationFingerprint(service), seedBefore);
    });
  } finally {
    await admin.auth.signOut();
    // Last-resort net: nothing this file created may survive, whichever subtest failed.
    const { count } = await service.from('aid_distributions').select('id', { count: 'exact', head: true });
    assert.equal(count, aidBefore, 'final: aid distribution count equals baseline');
    assert.equal(await notificationFingerprint(service), seedBefore, 'final: notification table equals baseline');
  }
});
