/**
 * Development seed.
 *
 * DEVELOPMENT / TESTING ONLY. Every person, phone number, national ID and
 * password below is fictional. Never run this against production.
 *
 * It imports assets/js/data/mock-data.js directly rather than restating the
 * fixtures, so the seeded database and the HTML/JS prototype cannot drift: this
 * file IS the executable migration map from the localStorage shapes to the
 * relational ones.
 *
 * Usage:
 *   cd supabase && npm install
 *   cp ../.env.example ../.env      # then fill in the two values
 *   npm run seed:reset              # wipe and reseed
 *   npm run seed                    # seed on top of an empty database
 *
 * Requires the SECRET (service_role) key. That key is server-side only and must
 * never appear in the frontend or in git.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

import seed from '../../assets/js/data/mock-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RESET = process.argv.includes('--reset');

/* ---- Environment -------------------------------------------------------- */

loadDotEnv(resolve(ROOT, '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  fail(
    'Missing configuration. Copy .env.example to .env and set SUPABASE_URL and\n' +
      'SUPABASE_SECRET_KEY (the secret / service_role key, from Project Settings → API Keys).'
  );
}

const db = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Old localStorage id -> new uuid, per collection. */
const ids = {
  camps: new Map(),
  organizations: new Map(),
  users: new Map(),
  families: new Map(),
  members: new Map(),
};

/* ---- Entry point -------------------------------------------------------- */

main().catch((error) => fail(error.message || String(error)));

async function main() {
  banner();

  if (RESET) await reset();

  await seedCamps();
  await seedOrganizations();
  await seedAccounts();
  await seedFamilies();
  await linkDisplacedAccounts();
  await seedAidDistributions();
  await seedRegistrationRequests();
  await seedDocuments();
  await seedMessages();
  await seedNotifications();
  await backdateTimestamps();

  await verify();
}

/* ---- Reset -------------------------------------------------------------- */

async function reset() {
  step('Clearing existing data');

  // Order matters: camps and organizations are protected by ON DELETE RESTRICT
  // because they are still referenced (campInUse / organizationInUse in the
  // prototype), so their dependants go first.
  // The two aid junction tables are omitted on purpose: they carry no `id`
  // column and cascade from aid_distributions.
  for (const table of [
    'documents',
    'notifications',
    'messages',
    'aid_distributions',
    'registration_requests',
    'families',
    'organizations',
    'camps',
  ]) {
    const { error } = await db.from(table).delete().not('id', 'is', null);
    if (error && !/no rows/i.test(error.message)) throw new Error(`${table}: ${error.message}`);
  }

  // Deleting the auth user cascades to profiles, preferences and notifications.
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  for (const user of data.users) {
    const { error: delError } = await db.auth.admin.deleteUser(user.id);
    if (delError) throw new Error(`deleteUser ${user.email}: ${delError.message}`);
  }

  // Restart reference codes at FAM-000001 so a reseed is byte-for-byte
  // comparable with the prototype's fixtures.
  const { error: seqError } = await db.rpc('reset_family_reference_sequence');
  if (seqError) throw new Error(`reset_family_reference_sequence: ${seqError.message}`);

  say(`  removed ${data.users.length} auth users and every application row`);
}

/* ---- Camps -------------------------------------------------------------- */

async function seedCamps() {
  step('Camps');

  for (const camp of seed.camps) {
    const row = await insert('camps', {
      name: camp.name,
      governorate: camp.governorate,
      city: camp.city,
      status: camp.status === 'active' ? 'active' : 'disabled',
    });
    ids.camps.set(camp.id, row.id);
  }

  say(`  ${seed.camps.length} camps`);
}

/* ---- Organizations (donors) --------------------------------------------- */

async function seedOrganizations() {
  step('Donor organizations');

  for (const org of seed.organizations) {
    const row = await insert('organizations', {
      name: org.name,
      // Both optional by domain rule 11.
      responsible_person: org.responsiblePerson || null,
      phone: org.phone || null,
    });
    ids.organizations.set(org.id, row.id);
  }

  say(`  ${seed.organizations.length} donors`);
}

/* ---- Accounts ------------------------------------------------------------ */

async function seedAccounts() {
  step('Auth users and profiles');

  for (const user of seed.users) {
    const { data, error } = await db.auth.admin.createUser({
      email: user.email,
      password: user.password,
      email_confirm: true,
      user_metadata: { full_name: user.name, phone: user.phone },
    });
    if (error) throw new Error(`createUser ${user.email}: ${error.message}`);

    ids.users.set(user.id, data.user.id);

    // The on_auth_user_created trigger has already written a `displaced` /
    // `pending` profile. Elevating it is a privileged, server-side act — this
    // is the only place a role is ever assigned outside the Super Admin's UI.
    await update(
      'profiles',
      { id: data.user.id },
      {
        full_name: user.name,
        phone: user.phone || null,
        role: user.role,
        camp_id: user.campId ? ids.camps.get(user.campId) : null,
        status: user.status,
      }
    );
  }

  const byRole = (role) => seed.users.filter((u) => u.role === role).length;
  say(
    `  1 super admin, ${byRole('camp_admin')} camp admins, ${byRole('displaced')} displaced accounts` +
      ` — password for all: ${seed.users[0].password}`
  );
}

/* ---- Families and members ------------------------------------------------ */

async function seedFamilies() {
  step('Families and displaced people');

  const membersOf = new Map();
  for (const person of seed.displaced) {
    if (!person.familyId) continue;
    if (!membersOf.has(person.familyId)) membersOf.set(person.familyId, []);
    membersOf.get(person.familyId).push(person);
  }

  // Insertion order decides the generated reference code, so seeding in id
  // order reproduces FAM-000001 … FAM-000008 exactly as the prototype shows.
  const families = [...seed.families].sort((a, b) => a.id.localeCompare(b.id));
  let memberCount = 0;

  for (const family of families) {
    const people = membersOf.get(family.id) || [];
    const head = people.find((p) => p.id === family.headId);
    if (!head) throw new Error(`family ${family.id} has no head in the seed data`);
    const rest = people.filter((p) => p.id !== family.headId);

    const { data: familyId, error } = await db.rpc('create_family_with_members', {
      p_camp_id: ids.camps.get(family.campId),
      p_head: toMemberPayload(head),
      p_members: rest.map(toMemberPayload),
      p_notes: family.notes || '',
      p_created_by: null,
    });
    if (error) throw new Error(`create_family_with_members ${family.id}: ${error.message}`);

    ids.families.set(family.id, familyId);
    memberCount += people.length;

    // Recover the generated member ids by national ID, which is unique.
    const { data: rows, error: readError } = await db
      .from('family_members')
      .select('id, national_id')
      .eq('family_id', familyId);
    if (readError) throw new Error(`read members of ${family.id}: ${readError.message}`);

    for (const person of people) {
      const match = rows.find((r) => r.national_id === person.nationalId);
      if (match) ids.members.set(person.id, match.id);
    }
  }

  say(`  ${families.length} families, ${memberCount} people`);
}

/**
 * localStorage record -> family_members payload.
 *
 * isPregnant / isBreastfeeding are passed through untouched: they are absent on
 * male records by design, and the database's normalize_maternity_fields trigger
 * enforces the same rule from the other side.
 */
function toMemberPayload(person) {
  return {
    full_name: person.fullName,
    full_name_en: person.fullNameEn || null,
    gender: person.gender,
    birth_date: person.birthDate || null,
    marital_status: person.maritalStatus,
    national_id: person.nationalId,
    passport_number: person.passportNumber || null,
    unrwa_number: person.unrwaNumber || null,
    nationality: person.nationality,
    phone: person.phone || null,
    alt_phone: person.altPhone || null,
    email: person.email || null,
    governorate: person.governorate || null,
    city: person.city || null,
    area: person.area || null,
    tent_type: person.tentType,
    origin_governorate: person.originGovernorate || null,
    origin_city: person.originCity || null,
    displacement_date: person.displacementDate || null,
    chronic_diseases: person.chronicDiseases || '',
    disability: person.disability || '',
    father_status: person.fatherStatus,
    mother_status: person.motherStatus,
    is_pregnant: person.isPregnant ?? null,
    is_breastfeeding: person.isBreastfeeding ?? null,
    work_status: person.workStatus,
    income_source: person.incomeSource,
    monthly_income: person.monthlyIncome,
    relationship: person.relationship,
    status: 'approved',
  };
}

/**
 * A displaced account points at its person record rather than repeating the
 * name, national ID or camp — the profile carries none of that itself.
 */
async function linkDisplacedAccounts() {
  step('Linking displaced accounts to their person records');

  let linked = 0;
  for (const user of seed.users) {
    if (!user.displacedId) continue;
    const memberId = ids.members.get(user.displacedId);
    if (!memberId) continue;

    const { data: member } = await db
      .from('family_members')
      .select('camp_id')
      .eq('id', memberId)
      .single();

    await update(
      'profiles',
      { id: ids.users.get(user.id) },
      { family_member_id: memberId, camp_id: member.camp_id }
    );
    linked += 1;
  }

  say(`  ${linked} accounts linked`);
}

/* ---- Aid ---------------------------------------------------------------- */

async function seedAidDistributions() {
  step('Aid distributions');

  for (const record of seed.aid) {
    const { error } = await db.rpc('create_aid_distribution', {
      p_organization_id: ids.organizations.get(record.organizationId),
      p_camp_id: ids.camps.get(record.campId),
      p_distributed_on: record.date,
      p_aid_type_codes: record.types,
      p_family_ids: record.familyIds.map((id) => ids.families.get(id)),
      p_all_families_selected: Boolean(record.allFamiliesSelected),
      p_created_by: ids.users.get(record.createdBy) || null,
    });
    if (error) throw new Error(`create_aid_distribution ${record.id}: ${error.message}`);
  }

  say(`  ${seed.aid.length} distributions (no value, no price, no individual recipient)`);
}

/* ---- Registration requests ----------------------------------------------- */

async function seedRegistrationRequests() {
  step('Registration requests');

  let approved = 0;
  let rejected = 0;

  for (const request of seed.registrationRequests) {
    const row = await insert('registration_requests', {
      full_name: request.fullName,
      national_id: request.nationalId,
      phone: request.phone,
      email: request.email,
      camp_id: ids.camps.get(request.campId),
      status: 'pending',
      note: '',
    });

    // Decided requests are produced by running the real workflow rather than
    // by writing an "approved" row directly, so the seed can never contain a
    // state the application itself could not have reached.
    if (request.status === 'approved') {
      const { error } = await db.rpc('approve_registration_request', { p_request_id: row.id });
      if (error) throw new Error(`approve ${request.id}: ${error.message}`);
      approved += 1;
    } else if (request.status === 'rejected') {
      const { error } = await db.rpc('reject_registration_request', {
        p_request_id: row.id,
        p_note: request.note || '',
      });
      if (error) throw new Error(`reject ${request.id}: ${error.message}`);
      rejected += 1;
    }
  }

  const pending = seed.registrationRequests.length - approved - rejected;
  say(`  ${pending} pending, ${approved} approved, ${rejected} rejected`);
}

/* ---- Documents ----------------------------------------------------------- */

async function seedDocuments() {
  step('Documents');

  for (const doc of seed.documents) {
    await insert('documents', {
      name: doc.name,
      category: doc.category,
      camp_id: ids.camps.get(doc.campId),
      family_id: ids.families.get(doc.familyId) || null,
      family_member_id: ids.members.get(doc.displacedId) || null,
      original_filename: doc.name,
      mime_type: doc.mime,
      file_size: doc.size,
      // Cloudinary is Phase 3; metadata only for now.
      storage_provider: 'pending',
      uploaded_by: ids.users.get(doc.uploadedBy) || null,
    });
  }

  say(`  ${seed.documents.length} document records (metadata only, no binaries, no expiry date)`);
}

/* ---- Messages ------------------------------------------------------------ */

async function seedMessages() {
  step('Messages');

  for (const message of seed.messages) {
    const campId = ids.camps.get(message.campId);
    const responder = seed.users.find(
      (u) => u.role === 'camp_admin' && u.campId === message.campId
    );

    await insert('messages', {
      sender_id: ids.users.get(message.fromUserId),
      camp_id: campId,
      recipient_role: message.toRole,
      subject: message.subject,
      body: message.body,
      status: message.status,
      reply: message.reply || null,
      replied_by: message.reply ? ids.users.get(responder?.id) || null : null,
      replied_at: message.reply ? message.repliedAt || message.createdAt : null,
    });
  }

  say(`  ${seed.messages.length} messages`);
}

/* ---- Notifications -------------------------------------------------------- */

async function seedNotifications() {
  step('Notifications');

  for (const notification of seed.notifications) {
    const recipient = ids.users.get(notification.userId);
    if (!recipient) continue;

    await insert('notifications', {
      recipient_id: recipient,
      type: notification.type,
      title: notification.title,
      body: notification.text,
      href: notification.href,
      is_read: notification.read,
      read_at: notification.read ? notification.createdAt : null,
    });
  }

  say(`  ${seed.notifications.length} notifications`);
}

/* ---- Timestamps ---------------------------------------------------------- */

/**
 * The prototype's dashboard charts group by created_at, so the seeded history
 * has to span months rather than collapsing onto today.
 */
async function backdateTimestamps() {
  step('Backdating created_at to match the prototype history');

  for (const family of seed.families) {
    const id = ids.families.get(family.id);
    if (id) await update('families', { id }, { created_at: family.createdAt });
  }

  for (const person of seed.displaced) {
    const id = ids.members.get(person.id);
    if (id) await update('family_members', { id }, { created_at: person.createdAt });
  }

  for (const message of seed.messages) {
    await update(
      'messages',
      { body: message.body },
      { created_at: message.createdAt }
    );
  }

  for (const notification of seed.notifications) {
    await update(
      'notifications',
      { title: notification.title, body: notification.text },
      { created_at: notification.createdAt }
    );
  }

  say('  done');
}

/* ---- Verification --------------------------------------------------------- */

/**
 * The database equivalent of store.validateData(): every rule the prototype
 * asserted about the mock data, re-checked against Postgres. Anything the
 * schema already makes impossible (duplicate national IDs, aid without a
 * beneficiary, an orphan flag written by hand) is listed as enforced rather
 * than re-tested here.
 */
async function verify() {
  step('Verifying');

  const problems = [];

  const counts = {};
  for (const table of [
    'camps',
    'profiles',
    'families',
    'family_members',
    'organizations',
    'aid_types',
    'aid_distributions',
    'aid_distribution_types',
    'aid_distribution_families',
    'registration_requests',
    'documents',
    'messages',
    'notifications',
  ]) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
    if (error) throw new Error(`count ${table}: ${error.message}`);
    counts[table] = count;
  }

  // Exactly one Super Admin (domain rule 1).
  const { count: superAdmins } = await db
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'super_admin');
  if (superAdmins !== 1) problems.push(`expected exactly 1 super admin, found ${superAdmins}`);

  // Every family has a head, and the head is one of its own members.
  const { data: families } = await db.from('families').select('id, reference_code, head_member_id');
  const { data: members } = await db.from('family_members').select('id, family_id, camp_id');
  const memberById = new Map(members.map((m) => [m.id, m]));
  for (const family of families) {
    const head = memberById.get(family.head_member_id);
    if (!head) problems.push(`${family.reference_code} has no head`);
    else if (head.family_id !== family.id) {
      problems.push(`head of ${family.reference_code} is not one of its members`);
    }
  }

  // Maternity flags exist only on female records (domain rule 16).
  const { count: maleWithMaternity } = await db
    .from('family_members')
    .select('*', { count: 'exact', head: true })
    .eq('gender', 'male')
    .or('is_pregnant.not.is.null,is_breastfeeding.not.is.null');
  if (maleWithMaternity) problems.push(`${maleWithMaternity} male records carry maternity flags`);

  // Orphan status is derived, and the seed contains real orphans to prove it.
  const { count: orphans } = await db
    .from('family_members')
    .select('*', { count: 'exact', head: true })
    .eq('is_orphan', true);

  // members_count is derived, never stored.
  const { data: stats } = await db
    .from('family_stats')
    .select('reference_code, members_count')
    .order('reference_code');

  say('');
  say('  Row counts');
  for (const [table, count] of Object.entries(counts)) {
    say(`    ${table.padEnd(28)} ${count}`);
  }
  say('');
  say(`  Derived: ${orphans} orphans, family sizes ${stats.map((s) => s.members_count).join(', ')}`);
  say('');

  if (problems.length) {
    say('  PROBLEMS');
    problems.forEach((p) => say(`    - ${p}`));
    process.exitCode = 1;
  } else {
    say('  All integrity checks passed.');
  }
}

/* ---- Small helpers -------------------------------------------------------- */

async function insert(table, row) {
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return data;
}

async function update(table, match, patch) {
  const { error } = await db.from(table).update(patch).match(match);
  if (error) throw new Error(`update ${table}: ${error.message}`);
}

function loadDotEnv(path) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

function banner() {
  say('');
  say('  Displaced Camps Management Platform — development seed');
  say('  DEVELOPMENT DATA ONLY. Every record below is fictional.');
  say(`  Target: ${SUPABASE_URL}`);
  say('');
}

function step(label) {
  say(`▸ ${label}`);
}

function say(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n  ✖ ${message}\n\n`);
  process.exit(1);
}
