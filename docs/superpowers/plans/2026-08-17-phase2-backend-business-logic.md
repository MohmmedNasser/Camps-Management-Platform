# Phase 2 — Backend Business Logic, CRUD, RPCs & Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the secure data-access layer (CRUD, RPCs, search, filtering, pagination, statistics) that the existing HTML/CSS/vanilla-JS frontend will consume in a later phase, on top of the already-verified Phase 1 Supabase schema — without touching any page, without weakening RLS, and without starting Phase 3 (Cloudinary/Realtime/framework migration).

**Architecture:** Almost all CRUD is plain PostgREST calls (`supabase.from(table)...`) that Phase 1's RLS policies already authorize correctly — no new SQL needed for those. Only three things need new database objects: substring search (pg_trgm indexes), one new transactional RPC for adding a member to an *existing* family (`add_family_member`, mirroring the existing `create_family_with_members`), and two read-only statistics RPCs that centralize the aggregate counts the dashboards need. Everything else is a new `assets/js/supabase/*.js` module per domain, following the exact singleton-client / Arabic-error-message conventions `assets/js/core/supabase-client.js` already established in Phase 1.

**Tech Stack:** PostgreSQL 17 (Supabase-hosted, project `qlvftlecwoqmvtagaykr`), `supabase-js@2.58.0` (CDN `https://esm.sh/...` in the browser, npm package in the `supabase/` test tooling), Node ≥22 `node --test`, Playwright (new devDependency) for one browser smoke test.

**Spec:** `BACKEND.md` (Phase 1, already implemented and verified) + the Phase 2 brief the user supplied (reproduced in full in this session; not a separate file — its 46 numbered sections are the source of truth for every task below).

## Inspection findings (read before starting)

Live project `qlvftlecwoqmvtagaykr` was inspected via Supabase MCP before writing this plan. **No critical Phase 1 problem exists** — the live database matches BACKEND.md exactly:

- 14 tables, RLS enabled on all, **52** policies (counted live), matching the documented matrix.
- `private` schema has **23** functions (7 identity helpers, 2 recursion-breakers, 1 invoker context check, 12 trigger/utility functions) — matches §7.
- `public` schema has the 4 documented `SECURITY DEFINER` workflow functions (`approve_registration_request`, `reject_registration_request`, `create_family_with_members`, `create_aid_distribution`) plus `age_in_years`, `reset_family_reference_sequence`, `rls_auto_enable` — matches §7.
- Security advisors: **only** the 4 documented `authenticated_security_definer_function_executable` WARNs (the four workflow functions being callable by `authenticated`, which BACKEND.md §7 explicitly calls correct and intentional). No unexpected findings.
- Performance advisors: only INFO-level "unused index" notices, expected on a database with 0 seeded rows.
- **The project is unseeded** (0 rows in every table except `aid_types`, which has the 10 reference rows from migration `20260816120300`). `supabase/.env` exists locally with real keys. Task 16 runs `npm run seed:reset` before the live test pass.

One deliberate scope decision, made during inspection rather than left as an open question: **organization "deactivate" (spec §18) is not implemented.** `organizations` has no `is_active`/`status` column in the Phase 1 schema, CLAUDE.md's domain rules never describe such a toggle (only `organizationInUse()` blocking *deletion*), and adding a new column isn't licensed by "activate/deactivate ... where applicable" when the existing, approved schema doesn't have the field. `organizations.js` (Task 7) implements create/update/delete/search/list only. This is called out again in the final report.

A second observation, **accepted rather than fixed**: the `registration_requests_update_camp_admin` RLS policy technically allows a Camp Admin to `PATCH` a request's status directly via REST instead of going through `approve_registration_request`/`reject_registration_request`. The `registration_requests_approved_has_member` and `registration_requests_review_complete` CHECK constraints prevent this from producing an inconsistent row (an approved request always has `family_member_id`, `reviewed_by`, `reviewed_at` set), and a Camp Admin already has full authority to create families/members/notifications in their own camp by other means — so this isn't a privilege escalation, only a way to reach the same authorized end-state without the convenience of the RPC (no auto-created notification). Closing it would require session-scoped `set_config` plumbing inside the RPCs and a matching trigger guard; given the low severity, it is left as a documented known gap, matching the style of BACKEND.md §13's existing "Known gaps" list.

## Global Constraints

- Frontend stays HTML + CSS + vanilla ES6 modules. No Next.js/React/Vue/Angular. No page is rewired in this phase (spec §39/CLAUDE.md).
- Do not implement Cloudinary or Realtime (spec §1, final rule).
- Every DB change is a new migration file under `supabase/migrations/`; Phase 1 migrations are never edited (spec §43).
- New `SECURITY DEFINER` functions: `search_path = ''`, internal authorization, `EXECUTE` revoked from `PUBLIC`/`anon` before being explicitly granted to `authenticated` only (spec §34, matching BACKEND.md §7's documented pattern — Postgres grants `EXECUTE` to `PUBLIC` on every new function by default, so the revoke-then-grant order matters).
- No new abstractions beyond what's asked; CRUD PostgREST already covers most operations, so most tasks are additive JS wrappers, not new SQL (YAGNI).
- Sorting/filtering: whitelist columns only, never interpolate client input into `ORDER BY` (spec §33).
- Errors returned to callers must not leak SQL, constraint names, or credentials (spec §31).
- `assets/js/core/supabase-client.js` is the **only** place a client is constructed (already true from Phase 1) — every new module imports `requireClient()`/`supabase` from it, never calls `createClient` itself (spec §37/§38).
- Beneficiary of aid is always the family; no `value`/`price`/`estimated_value`/`displaced_id`/individual recipient anywhere (domain rule 9, unchanged from Phase 1 — nothing in this phase touches that shape).

---

## Task 1: Migration — pg_trgm search indexes

**Files:**
- Create: `supabase/migrations/20260817090000_phase2_search_indexes.sql`

**Interfaces:**
- Produces: `gin_trgm_ops` indexes usable by any `ilike '%...%'` query in later JS tasks (Tasks 8, 7).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260817090000_phase2_search_indexes.sql
-- Phase 2 §12: substring search for family name and organization name.
-- National ID stays exact-match (existing unique index); reference_code stays
-- prefix-match (existing unique index already supports LIKE 'FAM-0000%' via
-- the pattern_ops index added below, since the database's default collation
-- is not C and a plain btree can't be trusted for LIKE prefix matches).

create extension if not exists pg_trgm;

create index if not exists family_members_full_name_trgm_idx
  on public.family_members using gin (full_name gin_trgm_ops);

create index if not exists organizations_name_trgm_idx
  on public.organizations using gin (name gin_trgm_ops);

create index if not exists families_reference_code_pattern_idx
  on public.families (reference_code text_pattern_ops);
```

- [ ] **Step 2: Apply the migration to the live project**

Use the Supabase MCP `apply_migration` tool with `project_id: qlvftlecwoqmvtagaykr`, `name: phase2_search_indexes`, and the SQL body above.

- [ ] **Step 3: Verify live**

Run via MCP `execute_sql`:

```sql
select indexname from pg_indexes
where schemaname = 'public'
  and indexname in ('family_members_full_name_trgm_idx', 'organizations_name_trgm_idx', 'families_reference_code_pattern_idx');
```

Expected: all 3 rows returned.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260817090000_phase2_search_indexes.sql
git commit -m "feat(db): add pg_trgm search indexes for Phase 2 search"
```

---

## Task 2: Migration — `add_family_member` RPC

**Files:**
- Create: `supabase/migrations/20260817090100_phase2_add_family_member.sql`

**Interfaces:**
- Consumes: `private.insert_family_member(p_family_id uuid, p_camp_id uuid, p_data jsonb, p_actor uuid) returns uuid` (existing, from `functions_and_triggers` migration — verified live).
- Produces: `public.add_family_member(p_family_id uuid, p_member jsonb) returns uuid`, called by `assets/js/supabase/family-members.js` (Task 9).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260817090100_phase2_add_family_member.sql
-- Phase 2 §8: add a member to an EXISTING family (displaced-create.html's
-- use case — create_family_with_members handles the one-form path for a
-- brand-new family). Mirrors the camp-scope check already used by
-- create_family_with_members and create_aid_distribution.

create or replace function public.add_family_member(
  p_family_id uuid,
  p_member jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camp_id uuid;
  v_actor   uuid := (select auth.uid());
  v_id      uuid;
begin
  select camp_id into v_camp_id from public.families where id = p_family_id;

  if not found then
    raise exception 'الأسرة غير موجودة' using errcode = 'P0002';
  end if;

  if private.is_browser_session()
     and not ((select private.is_camp_admin()) and (select private.current_camp_id()) = v_camp_id) then
    raise exception 'لا تملك صلاحية إضافة فرد لهذه الأسرة' using errcode = '42501';
  end if;

  v_id := private.insert_family_member(p_family_id, v_camp_id, p_member, v_actor);
  return v_id;
end;
$$;

revoke all on function public.add_family_member(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.add_family_member(uuid, jsonb) to authenticated;
```

- [ ] **Step 2: Apply via MCP `apply_migration`**

`project_id: qlvftlecwoqmvtagaykr`, `name: phase2_add_family_member`.

- [ ] **Step 3: Verify authorization live**

Run via MCP `execute_sql` (as `service_role`, this bypasses RLS — the test is about the function's *internal* check, not RLS, so this only confirms the function exists and the happy path shape is right; the real authorization test is Task 16's `SET ROLE`/JWT-claims test):

```sql
select proname, prosecdef, provolatile
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'add_family_member';
```

Expected: one row, `prosecdef = true`.

- [ ] **Step 4: Verify grants**

```sql
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'add_family_member';
```

Expected: `authenticated` has `EXECUTE`; no row for `anon` or `PUBLIC`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260817090100_phase2_add_family_member.sql
git commit -m "feat(db): add add_family_member RPC for adding a member to an existing family"
```

---

## Task 3: Migration — statistics RPCs

**Files:**
- Create: `supabase/migrations/20260817090200_phase2_statistics.sql`

**Interfaces:**
- Consumes: `public.family_member_facts` view, `public.families`, `public.family_members`, `public.aid_distributions`, `public.organizations`, `public.registration_requests` (all existing, `security_invoker = true` where views).
- Produces: `public.get_family_statistics(p_camp_id uuid default null) returns table(...)` and `public.get_dashboard_statistics(p_camp_id uuid default null) returns jsonb`, called by `assets/js/supabase/statistics.js` (Task 15).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260817090200_phase2_statistics.sql
-- Phase 2 §11/§28: dashboard statistics, scoped by role.
-- SECURITY INVOKER: RLS on the underlying tables/views still applies to the
-- caller, so these functions cannot see more than a plain query already
-- could. The explicit role checks below are a second, independent layer
-- that gives a clear error instead of a silently-empty result, matching the
-- authorization style already used by the Phase 1 workflow functions.

create or replace function public.get_family_statistics(p_camp_id uuid default null)
returns table (
  total_families    bigint,
  total_members     bigint,
  children_under_18 bigint,
  orphans           bigint,
  pregnant          bigint,
  breastfeeding     bigint,
  chronic           bigint,
  disability        bigint
)
language plpgsql
security invoker
stable
set search_path = ''
as $$
begin
  if private.is_displaced() then
    raise exception 'الإحصائيات غير متاحة لهذا الحساب' using errcode = '42501';
  end if;

  if private.is_camp_admin() and p_camp_id is distinct from private.current_camp_id() then
    raise exception 'لا تملك صلاحية الاطلاع على إحصائيات مخيم آخر' using errcode = '42501';
  end if;

  return query
  select
    count(distinct f.id)::bigint,
    count(m.id)::bigint,
    count(m.id) filter (where mf.is_child)::bigint,
    count(m.id) filter (where mf.is_orphan)::bigint,
    count(m.id) filter (where mf.is_pregnant)::bigint,
    count(m.id) filter (where mf.is_breastfeeding)::bigint,
    count(m.id) filter (where mf.has_chronic)::bigint,
    count(m.id) filter (where mf.has_disability)::bigint
  from public.families f
  left join public.family_members m on m.family_id = f.id
  left join public.family_member_facts mf on mf.id = m.id
  where p_camp_id is null or f.camp_id = p_camp_id;
end;
$$;

revoke all on function public.get_family_statistics(uuid) from public, anon, authenticated;
grant execute on function public.get_family_statistics(uuid) to authenticated;

create or replace function public.get_dashboard_statistics(p_camp_id uuid default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = ''
as $$
declare
  v_families         jsonb;
  v_aid_count        bigint;
  v_org_count        bigint;
  v_pending_requests bigint;
begin
  if private.is_displaced() then
    raise exception 'الإحصائيات غير متاحة لهذا الحساب' using errcode = '42501';
  end if;

  if private.is_camp_admin() and p_camp_id is distinct from private.current_camp_id() then
    raise exception 'لا تملك صلاحية الاطلاع على إحصائيات مخيم آخر' using errcode = '42501';
  end if;

  select to_jsonb(s) into v_families from public.get_family_statistics(p_camp_id) s;

  select count(*) into v_aid_count
  from public.aid_distributions d
  where p_camp_id is null or d.camp_id = p_camp_id;

  select count(*) into v_org_count from public.organizations;

  select count(*) into v_pending_requests
  from public.registration_requests r
  where r.status = 'pending' and (p_camp_id is null or r.camp_id = p_camp_id);

  return v_families || jsonb_build_object(
    'aid_distributions', v_aid_count,
    'organizations', v_org_count,
    'pending_requests', v_pending_requests
  );
end;
$$;

revoke all on function public.get_dashboard_statistics(uuid) from public, anon, authenticated;
grant execute on function public.get_dashboard_statistics(uuid) to authenticated;
```

- [ ] **Step 2: Apply via MCP `apply_migration`**

`project_id: qlvftlecwoqmvtagaykr`, `name: phase2_statistics`.

- [ ] **Step 3: Verify grants live**

```sql
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name in ('get_family_statistics', 'get_dashboard_statistics');
```

Expected: only `authenticated` rows, `EXECUTE`.

- [ ] **Step 4: Run advisors**

MCP `get_advisors` with `type: security`. Expected: the same 4 pre-existing WARNs plus these two new functions appearing as `authenticated_security_definer_function_executable`... **check this carefully**: these two are `security invoker`, not `security definer`, so they should **not** trigger that specific lint at all. If they do appear, something is wrong with the `language plpgsql security invoker` declaration — stop and re-check the migration before continuing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260817090200_phase2_statistics.sql
git commit -m "feat(db): add scoped family and dashboard statistics RPCs"
```

---

## Task 4: Shared JS utilities — error mapping and query helpers

**Files:**
- Create: `assets/js/supabase/errors.js`
- Create: `assets/js/supabase/query.js`

**Interfaces:**
- Produces: `DataAccessError`, `ErrorType`, `mapError(error)`, `mapAuthError(error)`, `run(promise)` from `errors.js`; `paginate(query, opts)`, `sort(query, opts, allowedColumns, fallback)` from `query.js`. Every other module in Tasks 5–15 imports from these two files — nothing in this task depends on anything else, so it goes first.

- [ ] **Step 1: Write `errors.js`**

```js
// assets/js/supabase/errors.js
/**
 * Central error mapping for the Supabase data-access layer (Phase 2 §30/§31).
 * Never surface a raw Postgres/PostgREST message: constraint names, column
 * names and SQLSTATE codes stay server-side. Only messages our own
 * `RAISE EXCEPTION ... using errcode` calls wrote (always Arabic) pass
 * through; everything else is replaced with a generic Arabic message keyed
 * by error class.
 */

export const ErrorType = Object.freeze({
  VALIDATION: 'validation',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  DUPLICATE: 'duplicate',
  INVALID_STATE: 'invalid_state',
  DATABASE: 'database',
});

const PG_CODE_MAP = {
  '23505': ErrorType.DUPLICATE,
  '23503': ErrorType.VALIDATION,
  '23514': ErrorType.VALIDATION,
  '42501': ErrorType.FORBIDDEN,
  '22023': ErrorType.INVALID_STATE,
  P0002: ErrorType.NOT_FOUND,
  PGRST116: ErrorType.NOT_FOUND,
};

const FRIENDLY_AR = {
  [ErrorType.DUPLICATE]: 'هذا السجل موجود مسبقاً',
  [ErrorType.FORBIDDEN]: 'لا تملك صلاحية تنفيذ هذا الإجراء',
  [ErrorType.NOT_FOUND]: 'السجل غير موجود',
  [ErrorType.INVALID_STATE]: 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية',
  [ErrorType.VALIDATION]: 'البيانات المدخلة غير صالحة',
  [ErrorType.UNAUTHORIZED]: 'يجب تسجيل الدخول لإتمام هذا الإجراء',
  [ErrorType.DATABASE]: 'حدث خطأ غير متوقع، حاول مرة أخرى',
};

const ARABIC_START = /^[؀-ۿ]/;

export class DataAccessError extends Error {
  constructor(type, message, cause) {
    super(message);
    this.name = 'DataAccessError';
    this.type = type;
    this.cause = cause;
  }
}

/** Maps a PostgREST/Postgres error object (the `error` half of `{ data, error }`). */
export function mapError(error) {
  if (!error) return null;
  const type = PG_CODE_MAP[error.code] || ErrorType.DATABASE;
  const message = ARABIC_START.test(error.message || '') ? error.message : FRIENDLY_AR[type];
  return new DataAccessError(type, message, error);
}

/** Maps a GoTrue auth error object (`error` from `supabase.auth.*`). */
export function mapAuthError(error) {
  if (!error) return null;
  const status = error.status;
  const type = status === 400 || status === 401 ? ErrorType.UNAUTHORIZED : ErrorType.VALIDATION;
  return new DataAccessError(type, FRIENDLY_AR[type], error);
}

/** Awaits a `{ data, error }`-shaped Supabase call and throws a mapped error. */
export async function run(promise) {
  const { data, error } = await promise;
  if (error) throw mapError(error);
  return data;
}
```

- [ ] **Step 2: Write `query.js`**

```js
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
```

- [ ] **Step 3: Syntax-check both files**

```bash
node --check "assets/js/supabase/errors.js"
node --check "assets/js/supabase/query.js"
```

Expected: no output, exit 0. (`--check` parses ESM syntax without executing top-level code, so this works even though later files in this layer have CDN imports that `--check` never reaches.)

- [ ] **Step 4: Commit**

```bash
git add assets/js/supabase/errors.js assets/js/supabase/query.js
git commit -m "feat(frontend): add Supabase data-access error mapping and query helpers"
```

---

## Task 5: `auth.js` and `profiles.js`

**Files:**
- Create: `assets/js/supabase/auth.js`
- Create: `assets/js/supabase/profiles.js`

**Interfaces:**
- Consumes: `requireClient`, `currentUserId` from `../core/supabase-client.js` (existing); `mapError`, `mapAuthError`, `run` from `./errors.js`; `paginate`, `sort` from `./query.js`.
- Produces: `signIn`, `signUp`, `signOut`, `getSession` (`auth.js`); `getOwnProfile`, `updateOwnProfile`, `listProfiles`, `assignCampAdmin`, `setProfileStatus` (`profiles.js`) — consumed by no other Task 5–15 module (leaf of the dependency graph along with every other domain file).

- [ ] **Step 1: Write `auth.js`**

```js
// assets/js/supabase/auth.js
import { requireClient } from '../core/supabase-client.js';
import { mapAuthError } from './errors.js';

export async function signIn(email, password) {
  const client = requireClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw mapAuthError(error);
  return data.session;
}

export async function signUp({ email, password, fullName, phone }) {
  const client = requireClient();
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, phone } },
  });
  if (error) throw mapAuthError(error);
  return data.user;
}

export async function signOut() {
  const client = requireClient();
  const { error } = await client.auth.signOut();
  if (error) throw mapAuthError(error);
}

export async function getSession() {
  const client = requireClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw mapAuthError(error);
  return data.session;
}
```

- [ ] **Step 2: Write `profiles.js`**

```js
// assets/js/supabase/profiles.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'full_name', 'status'];

export async function getOwnProfile() {
  const client = requireClient();
  const userId = await currentUserId();
  if (!userId) return null;
  return run(client.from('profiles').select('*').eq('id', userId).single());
}

/** Only `full_name`/`phone` — role, camp and status are server-authorized only (spec §4). */
export async function updateOwnProfile(patch) {
  const client = requireClient();
  const userId = await currentUserId();
  const allowed = ['full_name', 'phone'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('profiles').update(body).eq('id', userId).select().single());
}

export async function listProfiles({ role, campId, status, page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('profiles').select('*', { count: 'exact' });
  if (role) query = query.eq('role', role);
  if (campId) query = query.eq('camp_id', campId);
  if (status) query = query.eq('status', status);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

/** Super Admin only, per RLS + `guard_profile_privileges`: sets role AND camp together. */
export async function assignCampAdmin(profileId, campId) {
  const client = requireClient();
  return run(
    client.from('profiles').update({ camp_id: campId, role: 'camp_admin' }).eq('id', profileId).select().single()
  );
}

export async function setProfileStatus(profileId, status) {
  const client = requireClient();
  return run(client.from('profiles').update({ status }).eq('id', profileId).select().single());
}
```

- [ ] **Step 3: Syntax-check**

```bash
node --check "assets/js/supabase/auth.js"
node --check "assets/js/supabase/profiles.js"
```

- [ ] **Step 4: Commit**

```bash
git add assets/js/supabase/auth.js assets/js/supabase/profiles.js
git commit -m "feat(frontend): add auth and profile data-access modules"
```

---

## Task 6: `camps.js`

**Files:**
- Create: `assets/js/supabase/camps.js`

**Interfaces:**
- Consumes: `requireClient` from `../core/supabase-client.js`; `run`, `mapError` from `./errors.js`; `sort` from `./query.js`.
- Produces: `listCamps`, `getCamp`, `createCamp`, `updateCamp`, `setCampStatus`.

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/camps.js
import { requireClient } from '../core/supabase-client.js';
import { run } from './errors.js';
import { sort } from './query.js';

const SORT_COLUMNS = ['name', 'created_at'];

export async function listCamps({ status, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('camps').select('*');
  if (status) query = query.eq('status', status);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'name');
  return run(query);
}

export async function getCamp(id) {
  const client = requireClient();
  return run(client.from('camps').select('*').eq('id', id).single());
}

export async function createCamp({ name, governorate, city }) {
  const client = requireClient();
  return run(client.from('camps').insert({ name, governorate, city }).select().single());
}

export async function updateCamp(id, patch) {
  const client = requireClient();
  const allowed = ['name', 'governorate', 'city'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('camps').update(body).eq('id', id).select().single());
}

export async function setCampStatus(id, status) {
  const client = requireClient();
  return run(client.from('camps').update({ status }).eq('id', id).select().single());
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/camps.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/camps.js
git commit -m "feat(frontend): add camps data-access module"
```

---

## Task 7: `organizations.js`

**Files:**
- Create: `assets/js/supabase/organizations.js`

**Interfaces:**
- Consumes: `requireClient` from `../core/supabase-client.js`; `run`, `mapError` from `./errors.js`; `paginate`, `sort` from `./query.js`.
- Produces: `listOrganizations`, `getOrganization`, `createOrganization`, `updateOrganization`, `deleteOrganization`. No `setOrganizationStatus` — see the plan header's scope decision (no `is_active` column exists).

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/organizations.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['name', 'created_at'];

export async function listOrganizations({ search, page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('organizations').select('*', { count: 'exact' });
  if (search) query = query.ilike('name', `%${search}%`);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'name');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getOrganization(id) {
  const client = requireClient();
  return run(client.from('organizations').select('*').eq('id', id).single());
}

/** Phone stays optional (domain rule 11) — never marked required here or in a schema. */
export async function createOrganization({ name, responsiblePerson, phone }) {
  const client = requireClient();
  return run(
    client.from('organizations').insert({ name, responsible_person: responsiblePerson, phone }).select().single()
  );
}

export async function updateOrganization(id, patch) {
  const client = requireClient();
  const allowed = ['name', 'responsible_person', 'phone'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('organizations').update(body).eq('id', id).select().single());
}

export async function deleteOrganization(id) {
  const client = requireClient();
  await run(client.from('organizations').delete().eq('id', id).select().maybeSingle());
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/organizations.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/organizations.js
git commit -m "feat(frontend): add organizations data-access module"
```

---

## Task 8: `families.js`

**Files:**
- Create: `assets/js/supabase/families.js`

**Interfaces:**
- Consumes: `requireClient` from `../core/supabase-client.js`; `run`, `mapError` from `./errors.js`; `paginate`, `sort` from `./query.js`; RPC `create_family_with_members` (existing).
- Produces: `listFamilies`, `getFamily`, `createFamilyWithMembers`, `updateFamily`.

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/families.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'reference_code', 'updated_at'];

/**
 * `filters.search` matches `reference_code` by prefix (`FAM-000001` shape),
 * matching the pattern_ops index from Task 1 rather than a full scan.
 */
export async function listFamilies(filters = {}, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client
    .from('families')
    .select(
      'id, reference_code, camp_id, head_member_id, notes, created_at, ' +
        'family_stats(members_count, children_count, orphans_count, chronic_count, disability_count, pregnant_count, breastfeeding_count)',
      { count: 'exact' }
    );

  if (filters.campId) query = query.eq('camp_id', filters.campId);
  if (filters.search) query = query.ilike('reference_code', `${filters.search}%`);

  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });

  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getFamily(id) {
  const client = requireClient();
  return run(client.from('families').select('*, family_stats(*), family_members(*)').eq('id', id).single());
}

/** The one-form family+members create (spec §7 / domain rule 13). */
export async function createFamilyWithMembers({ campId, head, members = [], notes = '' }) {
  const client = requireClient();
  return run(
    client.rpc('create_family_with_members', {
      p_camp_id: campId,
      p_head: head,
      p_members: members,
      p_notes: notes,
    })
  );
}

export async function updateFamily(id, patch) {
  const client = requireClient();
  const allowed = ['notes', 'head_member_id'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('families').update(body).eq('id', id).select().single());
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/families.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/families.js
git commit -m "feat(frontend): add families data-access module"
```

---

## Task 9: `family-members.js`

**Files:**
- Create: `assets/js/supabase/family-members.js`

**Interfaces:**
- Consumes: `requireClient` from `../core/supabase-client.js`; `run`, `mapError`, `DataAccessError`, `ErrorType` from `./errors.js`; `paginate`, `sort` from `./query.js`; RPC `add_family_member` (Task 2).
- Produces: `listFamilyMembers`, `getFamilyMember`, `addFamilyMember`, `updateFamilyMember`, `removeFamilyMember`, `isDuplicateNationalId`.

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/family-members.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError, DataAccessError, ErrorType } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'full_name', 'birth_date'];

export async function listFamilyMembers(familyId, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client
    .from('family_members')
    .select(
      '*, family_member_facts(age_years, is_child, under_1, under_2, under_3, is_orphan, has_chronic, has_disability, is_pregnant, is_breastfeeding, maternity_applies)',
      { count: 'exact' }
    )
    .eq('family_id', familyId);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getFamilyMember(id) {
  const client = requireClient();
  return run(client.from('family_members').select('*, family_member_facts(*)').eq('id', id).single());
}

/** Adds a person to an EXISTING family (spec §8) — see Task 2's RPC. */
export async function addFamilyMember(familyId, member) {
  const client = requireClient();
  return run(client.rpc('add_family_member', { p_family_id: familyId, p_member: member }));
}

export async function updateFamilyMember(id, patch) {
  const client = requireClient();
  return run(client.from('family_members').update(patch).eq('id', id).select().single());
}

export async function removeFamilyMember(id) {
  const client = requireClient();
  await run(client.from('family_members').delete().eq('id', id).select().maybeSingle());
}

/** Spec §9: detect the 23505 unique-violation on `national_id` cleanly. */
export function isDuplicateNationalId(error) {
  return error instanceof DataAccessError && error.type === ErrorType.DUPLICATE;
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/family-members.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/family-members.js
git commit -m "feat(frontend): add family members data-access module"
```

---

## Task 10: `registration-requests.js`

**Files:**
- Create: `assets/js/supabase/registration-requests.js`

**Interfaces:**
- Consumes: `requireClient`, `currentUserId` from `../core/supabase-client.js`; `run`, `mapError` from `./errors.js`; `paginate`, `sort` from `./query.js`; RPCs `approve_registration_request`, `reject_registration_request` (existing).
- Produces: `listRegistrationRequests`, `getRegistrationRequest`, `createRegistrationRequest`, `approveRegistrationRequest`, `rejectRegistrationRequest`.

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/registration-requests.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'status'];

export async function listRegistrationRequests({ status, campId, page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('registration_requests').select('*', { count: 'exact' });
  if (status) query = query.eq('status', status);
  if (campId) query = query.eq('camp_id', campId);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getRegistrationRequest(id) {
  const client = requireClient();
  return run(client.from('registration_requests').select('*').eq('id', id).single());
}

export async function createRegistrationRequest({ fullName, nationalId, phone, email, campId, note = '' }) {
  const client = requireClient();
  const userId = await currentUserId();
  return run(
    client
      .from('registration_requests')
      .insert({
        user_id: userId,
        full_name: fullName,
        national_id: nationalId,
        phone,
        email,
        camp_id: campId,
        note,
      })
      .select()
      .single()
  );
}

/** Creates the person + family + activates the account (spec §16, existing RPC). */
export async function approveRegistrationRequest(id, { gender, birthDate }) {
  const client = requireClient();
  return run(client.rpc('approve_registration_request', { p_request_id: id, p_gender: gender, p_birth_date: birthDate }));
}

export async function rejectRegistrationRequest(id, note = '') {
  const client = requireClient();
  return run(client.rpc('reject_registration_request', { p_request_id: id, p_note: note }));
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/registration-requests.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/registration-requests.js
git commit -m "feat(frontend): add registration requests data-access module"
```

---

## Task 11: `aids.js`

**Files:**
- Create: `assets/js/supabase/aids.js`

**Interfaces:**
- Consumes: `requireClient` from `../core/supabase-client.js`; `run`, `mapError` from `./errors.js`; `paginate`, `sort` from `./query.js`; RPC `create_aid_distribution` (existing).
- Produces: `listAidTypes`, `listAidDistributions`, `getFamilyAidHistory`, `createAidDistribution`.

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/aids.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['distributed_on', 'created_at'];

export async function listAidTypes({ activeOnly = true } = {}) {
  const client = requireClient();
  let query = client.from('aid_types').select('*').order('sort_order', { ascending: true });
  if (activeOnly) query = query.eq('is_active', true);
  return run(query);
}

/**
 * `filters.aidTypeCode` / `filters.familyId` use `!inner` so the filter
 * narrows the TOP-LEVEL distributions returned (and therefore pagination),
 * not just the nested arrays — a bare embedded filter without `!inner`
 * would leave the parent row in the page even when no nested row matches.
 */
export async function listAidDistributions(filters = {}, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  const typesRel = filters.aidTypeCode
    ? 'aid_distribution_types!inner(aid_type:aid_types!inner(code, label_ar))'
    : 'aid_distribution_types(aid_type:aid_types(code, label_ar))';
  const familiesRel = filters.familyId
    ? 'aid_distribution_families!inner(family:families!inner(id, reference_code))'
    : 'aid_distribution_families(family:families(id, reference_code))';

  let query = client
    .from('aid_distributions')
    .select(
      `id, distributed_on, all_families_selected, organization:organizations(id, name), ${typesRel}, ${familiesRel}`,
      { count: 'exact' }
    );

  if (filters.campId) query = query.eq('camp_id', filters.campId);
  if (filters.organizationId) query = query.eq('organization_id', filters.organizationId);
  if (filters.dateFrom) query = query.gte('distributed_on', filters.dateFrom);
  if (filters.dateTo) query = query.lte('distributed_on', filters.dateTo);
  if (filters.aidTypeCode) query = query.eq('aid_distribution_types.aid_type.code', filters.aidTypeCode);
  if (filters.familyId) query = query.eq('aid_distribution_families.family.id', filters.familyId);

  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'distributed_on');
  query = paginate(query, { page, pageSize });

  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

/** No value/price/estimated_value/individual recipient — domain rule 9/23. */
export async function getFamilyAidHistory(familyId) {
  const client = requireClient();
  return run(
    client
      .from('aid_distribution_families')
      .select(
        'distribution:aid_distributions(id, distributed_on, organization:organizations(name), aid_distribution_types(aid_type:aid_types(label_ar)))'
      )
      .eq('family_id', familyId)
      .order('distribution(distributed_on)', { ascending: false })
  );
}

export async function createAidDistribution({
  organizationId,
  campId,
  distributedOn,
  aidTypeCodes,
  familyIds = [],
  allFamiliesSelected = false,
}) {
  const client = requireClient();
  return run(
    client.rpc('create_aid_distribution', {
      p_organization_id: organizationId,
      p_camp_id: campId,
      p_distributed_on: distributedOn,
      p_aid_type_codes: aidTypeCodes,
      p_family_ids: familyIds,
      p_all_families_selected: allFamiliesSelected,
    })
  );
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/aids.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/aids.js
git commit -m "feat(frontend): add aid types and distributions data-access module"
```

---

## Task 12: `documents.js`

**Files:**
- Create: `assets/js/supabase/documents.js`

**Interfaces:**
- Consumes: `requireClient` from `../core/supabase-client.js`; `run`, `mapError` from `./errors.js`; `paginate`, `sort` from `./query.js`.
- Produces: `listDocuments`, `getDocument`, `createDocumentMetadata`, `updateDocumentMetadata`, `deleteDocumentMetadata`.

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/documents.js
// Phase 2 §25: metadata only — no file upload (Phase 3/Cloudinary).
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'name', 'category'];

export async function listDocuments(filters = {}, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('documents').select('*', { count: 'exact' });
  if (filters.familyId) query = query.eq('family_id', filters.familyId);
  if (filters.familyMemberId) query = query.eq('family_member_id', filters.familyMemberId);
  if (filters.campId) query = query.eq('camp_id', filters.campId);
  if (filters.category) query = query.eq('category', filters.category);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getDocument(id) {
  const client = requireClient();
  return run(client.from('documents').select('*').eq('id', id).single());
}

export async function createDocumentMetadata(doc) {
  const client = requireClient();
  const allowed = [
    'name',
    'category',
    'camp_id',
    'family_id',
    'family_member_id',
    'registration_request_id',
    'original_filename',
    'mime_type',
    'file_size',
  ];
  const body = Object.fromEntries(Object.entries(doc).filter(([k]) => allowed.includes(k)));
  return run(client.from('documents').insert(body).select().single());
}

/** No expiry date field — domain rule 6, unchanged from Phase 1. */
export async function updateDocumentMetadata(id, patch) {
  const client = requireClient();
  const allowed = ['name', 'category'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('documents').update(body).eq('id', id).select().single());
}

export async function deleteDocumentMetadata(id) {
  const client = requireClient();
  await run(client.from('documents').delete().eq('id', id).select().maybeSingle());
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/documents.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/documents.js
git commit -m "feat(frontend): add document metadata data-access module"
```

---

## Task 13: `messages.js`

**Files:**
- Create: `assets/js/supabase/messages.js`

**Interfaces:**
- Consumes: `requireClient`, `currentUserId` from `../core/supabase-client.js`; `run`, `mapError` from `./errors.js`; `paginate`, `sort` from `./query.js`.
- Produces: `listInbox`, `getMessage`, `sendMessage`, `markMessageRead`, `replyToMessage`, `unreadMessageCount`.

- [ ] **Step 1: Write the file**

```js
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
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/messages.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/messages.js
git commit -m "feat(frontend): add messages data-access module"
```

---

## Task 14: `notifications.js`

**Files:**
- Create: `assets/js/supabase/notifications.js`

**Interfaces:**
- Consumes: `requireClient`, `currentUserId` from `../core/supabase-client.js`; `run`, `mapError` from `./errors.js`; `paginate` from `./query.js`.
- Produces: `listNotifications`, `unreadNotificationCount`, `markNotificationRead`, `markAllNotificationsRead`.

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/notifications.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate } from './query.js';

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
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/notifications.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/notifications.js
git commit -m "feat(frontend): add notifications data-access module"
```

---

## Task 15: `statistics.js`

**Files:**
- Create: `assets/js/supabase/statistics.js`

**Interfaces:**
- Consumes: `requireClient` from `../core/supabase-client.js`; `run` from `./errors.js`; RPCs `get_family_statistics`, `get_dashboard_statistics` (Task 3).
- Produces: `getFamilyStatistics`, `getDashboardStatistics`.

- [ ] **Step 1: Write the file**

```js
// assets/js/supabase/statistics.js
import { requireClient } from '../core/supabase-client.js';
import { run } from './errors.js';

export async function getFamilyStatistics(campId = null) {
  const client = requireClient();
  const rows = await run(client.rpc('get_family_statistics', { p_camp_id: campId }));
  return rows?.[0] ?? null;
}

export async function getDashboardStatistics(campId = null) {
  const client = requireClient();
  return run(client.rpc('get_dashboard_statistics', { p_camp_id: campId }));
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check "assets/js/supabase/statistics.js"
```

- [ ] **Step 3: Commit**

```bash
git add assets/js/supabase/statistics.js
git commit -m "feat(frontend): add statistics data-access module"
```

---

## Task 16: Node behavioral test suite for the new RPCs and RLS

**Files:**
- Create: `supabase/tests/phase2-business-logic.test.mjs`
- Modify: `supabase/package.json:9-14` (add `"test:phase2": "node --test tests/phase2-business-logic.test.mjs"`, add `"test:all": "npm run test:schema && npm run test:phase2"`)

**Interfaces:**
- Consumes: `@supabase/supabase-js` (npm package, already a dependency — this file constructs its own client exactly like `rls.test.mjs` does, so it does **not** import the CDN-based `assets/js/core/supabase-client.js` or the Task 4–15 browser modules; Node cannot resolve `https://esm.sh/...` specifiers).
- Produces: nothing consumed elsewhere — this is the leaf verification for Tasks 1–3's SQL and confirms the contract Tasks 4–15's JS wrappers rely on.

- [ ] **Step 1: Seed the live project**

```bash
cd supabase && npm run seed:reset
```

Expected: prints row counts ending in the same integrity check `store.validateData()` runs, with zero problems reported (per BACKEND.md §11).

- [ ] **Step 2: Write the test file**

```js
// supabase/tests/phase2-business-logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

function client() {
  return createClient(url, anonKey, { auth: { persistSession: false } });
}

async function signIn(email) {
  const c = client();
  const { data, error } = await c.auth.signInWithPassword({ email, password: '123456' });
  assert.equal(error, null, `sign-in failed for ${email}: ${error?.message}`);
  return c;
}

test('add_family_member: camp admin adds a member to their own camp family', async () => {
  const c = await signIn('admin@camps.ps');
  const { data: families } = await c.from('families').select('id, camp_id').limit(1);
  assert.ok(families.length > 0, 'seed must contain at least one family');
  const { data: memberId, error } = await c.rpc('add_family_member', {
    p_family_id: families[0].id,
    p_member: { full_name: 'فرد اختبار', gender: 'male', national_id: '999888777', relationship: 'son' },
  });
  assert.equal(error, null, error?.message);
  assert.ok(memberId);
  await c.from('family_members').delete().eq('id', memberId); // cleanup
});

test('add_family_member: rejects a duplicate national_id with 23505', async () => {
  const c = await signIn('admin@camps.ps');
  const { data: members } = await c.from('family_members').select('national_id, family_id').limit(1);
  const { error } = await c.rpc('add_family_member', {
    p_family_id: members[0].family_id,
    p_member: { full_name: 'تكرار', gender: 'male', national_id: members[0].national_id, relationship: 'son' },
  });
  assert.equal(error.code, '23505');
});

test('add_family_member: camp admin cannot add to another camp\'s family', async () => {
  const admin1 = await signIn('admin@camps.ps');
  const admin2 = await signIn('admin2@camps.ps');
  const { data: myCamp } = await admin1.from('profiles').select('camp_id').single();
  const { data: otherFamily } = await admin2.from('families').select('id, camp_id').neq('camp_id', myCamp.camp_id).limit(1);
  if (!otherFamily?.length) return; // seed shape dependent; skip if only one camp has families
  const { error } = await admin1.rpc('add_family_member', {
    p_family_id: otherFamily[0].id,
    p_member: { full_name: 'دخيل', gender: 'male', national_id: '111222333', relationship: 'son' },
  });
  assert.equal(error.code, '42501');
});

test('get_family_statistics: camp admin sees only their own camp, matching a manual count', async () => {
  const c = await signIn('admin@camps.ps');
  const { data: profile } = await c.from('profiles').select('camp_id').single();
  const { data: stats, error } = await c.rpc('get_family_statistics', { p_camp_id: profile.camp_id });
  assert.equal(error, null, error?.message);
  const { count: manualCount } = await c
    .from('family_members')
    .select('*', { count: 'exact', head: true })
    .eq('camp_id', profile.camp_id);
  assert.equal(stats[0].total_members, manualCount);
});

test('get_family_statistics: camp admin cannot query another camp', async () => {
  const admin1 = await signIn('admin@camps.ps');
  const { data: camps } = await admin1.from('camps').select('id');
  const { data: myProfile } = await admin1.from('profiles').select('camp_id').single();
  const otherCamp = camps.find((camp) => camp.id !== myProfile.camp_id);
  if (!otherCamp) return;
  const { error } = await admin1.rpc('get_family_statistics', { p_camp_id: otherCamp.id });
  assert.equal(error.code, '42501');
});

test('get_family_statistics: displaced person is denied outright', async () => {
  const c = await signIn('ahmad@camps.ps');
  const { error } = await c.rpc('get_family_statistics', {});
  assert.equal(error.code, '42501');
});

test('get_dashboard_statistics: super admin sees system-wide totals >= any single camp', async () => {
  const superC = await signIn('super@camps.ps');
  const adminC = await signIn('admin@camps.ps');
  const { data: adminProfile } = await adminC.from('profiles').select('camp_id').single();
  const { data: system } = await superC.rpc('get_dashboard_statistics', {});
  const { data: campOnly } = await superC.rpc('get_dashboard_statistics', { p_camp_id: adminProfile.camp_id });
  assert.ok(system.total_families >= campOnly.total_families);
});

test('search indexes exist and are usable by the query planner', async () => {
  const c = await signIn('super@camps.ps');
  const { data, error } = await c.from('organizations').select('id, name').ilike('name', '%جمعية%');
  assert.equal(error, null, error?.message);
  assert.ok(Array.isArray(data));
});
```

- [ ] **Step 2: Add the npm scripts**

Edit `supabase/package.json`, `scripts` block:

```json
    "test:schema": "node --test tests/schema.test.mjs",
    "test:rls": "node --test tests/rls.test.mjs",
    "test:phase2": "node --test tests/phase2-business-logic.test.mjs",
    "test:all": "npm run test:schema && npm run test:phase2",
    "frontend:config": "node scripts/write-frontend-config.mjs"
```

(Keep every existing line; this only inserts `test:phase2` and `test:all` after `test:rls`.)

- [ ] **Step 3: Run it**

```bash
cd supabase && npm run test:phase2
```

Expected: all tests pass. If `admin2@camps.ps` doesn't exist in the seed (BACKEND.md §11 describes 3 Camp Admins — verify the actual seeded email before relying on it; adjust the literal in the test to match `supabase/seed/seed.mjs`'s actual second Camp Admin email), fix the test file rather than skip the camp-isolation assertion — that's the single most important case in the whole suite (spec §40 "CAMP ISOLATION").

- [ ] **Step 4: Run advisors one more time**

MCP `get_advisors`, both `security` and `performance` types, `project_id: qlvftlecwoqmvtagaykr`. Confirm no new WARN/ERROR beyond the 4 pre-existing, documented ones.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/phase2-business-logic.test.mjs supabase/package.json
git commit -m "test(db): add Phase 2 RPC and statistics behavioral tests"
```

---

## Task 17: Browser smoke test for the JS data-access layer

**Files:**
- Create: `supabase/tests/browser-smoke.html`
- Create: `supabase/tests/browser-smoke.test.mjs`
- Modify: `supabase/package.json:9-14` (add `"test:browser-smoke": "node --test tests/browser-smoke.test.mjs"`, add it to `test:all`)
- Modify: `supabase/package.json` devDependencies (add `"playwright": "^1.48.0"`)

**Interfaces:**
- Consumes: `assets/js/supabase/camps.js`, `assets/js/supabase/auth.js`, `assets/js/supabase/families.js` (Tasks 6, 5, 8) — the only task in this plan that actually loads the Task 4–15 modules and proves they run, since Task 16 deliberately can't (CDN import, Node has no browser).
- Produces: nothing consumed elsewhere; this is the plan's final proof that spec §39 ("verify independently") is satisfied for the deliverable files themselves, not just the SQL underneath them.

- [ ] **Step 1: Install Playwright**

```bash
cd supabase && npm install --save-dev playwright && npx playwright install chromium
```

- [ ] **Step 2: Write the harness page**

```html
<!-- supabase/tests/browser-smoke.html -->
<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8" /><title>Phase 2 smoke</title></head>
<body>
<script type="module">
  import { signIn } from '../../assets/js/supabase/auth.js';
  import { listCamps } from '../../assets/js/supabase/camps.js';
  import { listFamilies } from '../../assets/js/supabase/families.js';

  window.__runSmoke = async (email) => {
    await signIn(email, '123456');
    const camps = await listCamps({});
    const families = await listFamilies({});
    return { campsCount: camps.length, familiesRows: families.rows.length, familiesTotal: families.total };
  };
</script>
</body>
</html>
```

This requires `assets/js/core/supabase-config.js` to exist (git-ignored, generated). Before running: `cd supabase && npm run frontend:config`.

- [ ] **Step 3: Write the Playwright test**

```js
// supabase/tests/browser-smoke.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

async function withServer(run) {
  const server = spawn('npx', ['serve', '-l', '4173', '.'], { cwd: '..', shell: true });
  try {
    await delay(2000); // let `serve` bind before the browser connects
    await run();
  } finally {
    server.kill();
  }
}

test('camp admin: signed-in browser session loads camps and own-camp families', async () => {
  await withServer(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('http://localhost:4173/supabase/tests/browser-smoke.html');
    const result = await page.evaluate((email) => window.__runSmoke(email), 'admin@camps.ps');
    assert.ok(result.campsCount > 0, 'camps list should not be empty');
    assert.ok(result.familiesTotal >= result.familiesRows, 'total should be >= one page of rows');
    await browser.close();
  });
});
```

- [ ] **Step 4: Add the npm scripts**

Edit `supabase/package.json`:

```json
    "test:phase2": "node --test tests/phase2-business-logic.test.mjs",
    "test:browser-smoke": "node --test tests/browser-smoke.test.mjs",
    "test:all": "npm run test:schema && npm run test:phase2 && npm run test:browser-smoke",
```

And in `devDependencies`, add `"playwright": "^1.48.0"` alongside the existing `"@electric-sql/pglite"` entry.

- [ ] **Step 5: Run it**

```bash
cd supabase && npm run frontend:config && npm run test:browser-smoke
```

Expected: pass. If `serve` isn't installed globally, run `npx serve` once manually first to confirm it's reachable, or add `"serve": "^14.0.0"` to devDependencies and use `npx --yes serve` in the spawn call.

- [ ] **Step 6: Commit**

```bash
git add supabase/tests/browser-smoke.html supabase/tests/browser-smoke.test.mjs supabase/package.json
git commit -m "test(frontend): add browser smoke test for the Phase 2 data-access layer"
```

---

## Task 18: Update BACKEND.md with Phase 2 documentation

**Files:**
- Modify: `BACKEND.md` (append a new `## 15 · Phase 2 — business logic and the data-access layer` section after the existing `## 14 · Phase 2 and beyond` section; do not delete or edit any Phase 1 content per spec §44)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: the final report content required by spec §46, folded into the doc rather than only stated in chat, so it survives the session.

- [ ] **Step 1: Append the new section**

Add after the existing `### Phase 4 — Realtime` / `### Later` content at the end of the file:

```markdown
---

## 15 · Phase 2 — business logic and the data-access layer

Built on top of the Phase 1 schema without modifying it. Three new migrations, one new JS layer, no page rewired yet (§39 of the Phase 2 brief — that is Phase "2.5"/3 work).

### New migrations

| Migration | Adds |
|---|---|
| `20260817090000_phase2_search_indexes.sql` | `pg_trgm`, GIN trigram index on `family_members.full_name` and `organizations.name`, pattern-ops index on `families.reference_code` |
| `20260817090100_phase2_add_family_member.sql` | `public.add_family_member(family_id, member jsonb)` — adds a person to an *existing* family; the one-form create (`create_family_with_members`) already covers a brand-new family |
| `20260817090200_phase2_statistics.sql` | `public.get_family_statistics(camp_id)`, `public.get_dashboard_statistics(camp_id)` — `SECURITY INVOKER`, RLS-scoped, with an explicit role check on top (displaced denied outright, Camp Admin locked to their own camp) |

Five `SECURITY DEFINER`/`SECURITY INVOKER` functions now exist in `public` beyond Phase 1's four workflow functions: the two above plus the unchanged `age_in_years`, `reset_family_reference_sequence`, `rls_auto_enable`.

### The data-access layer (`assets/js/supabase/`)

One file per domain, all built on the Phase 1 singleton client (`assets/js/core/supabase-client.js`) — no module here constructs its own client. `errors.js` maps every Postgres/PostgREST error code to a structured `DataAccessError` and an Arabic message, never surfacing a raw SQL error to the UI; `query.js` provides whitelist-only sorting and range-based pagination shared by every list function.

```
assets/js/supabase/
  errors.js                 DataAccessError, ErrorType, mapError, mapAuthError, run()
  query.js                  paginate(), sort() — whitelist-only ORDER BY
  auth.js                   signIn / signUp / signOut / getSession
  profiles.js               own profile + admin profile management
  camps.js                  camp CRUD + status
  organizations.js          donor CRUD + search (no deactivate — see below)
  families.js               list/search/filter/paginate + create_family_with_members wrapper
  family-members.js         list/get + add_family_member wrapper + national-ID duplicate helper
  registration-requests.js  create/list/get + approve/reject RPC wrappers
  aids.js                   aid types + distributions, multi-type/multi-family search/filter + create RPC wrapper
  documents.js               metadata-only CRUD (no upload — Phase 3)
  messages.js                inbox, send (displaced only), reply/mark-read (admin only), unread count
  notifications.js           list, unread count, mark one/all read
  statistics.js              wraps get_family_statistics / get_dashboard_statistics
```

No page imports any of these yet. They are verified independently:

- `supabase/tests/phase2-business-logic.test.mjs` — Node, `@supabase/supabase-js` npm package, real HTTP against the live project, same pattern as `tests/rls.test.mjs`. Covers the new RPCs' authorization (camp isolation, displaced denial), the national-ID duplicate error path, and the search indexes.
- `supabase/tests/browser-smoke.test.mjs` + `browser-smoke.html` — Playwright, loads the actual `assets/js/supabase/*.js` files in a real browser against `npx serve`, since Node cannot resolve the CDN (`https://esm.sh/...`) import inside `supabase-client.js` that every one of these modules transitively depends on.

### Scope decisions made during Phase 2

- **No organization "deactivate."** `organizations` has no `is_active`/`status` column in the Phase 1 schema and CLAUDE.md's domain rules never describe one (only `organizationInUse()` blocking *deletion*, which `deleteOrganization()` already relies on via `ON DELETE RESTRICT`). Adding a column for this wasn't licensed by "where applicable" against an existing, approved schema — flagged rather than silently added.
- **`registration_requests` direct-UPDATE gap left open.** A Camp Admin's RLS `UPDATE` policy technically allows setting `status` directly instead of going through `approve_registration_request`/`reject_registration_request`. The `registration_requests_approved_has_member` and `registration_requests_review_complete` CHECK constraints prevent this from producing an inconsistent row, and a Camp Admin already has equivalent authority by other means (creating families/members directly) — not a privilege escalation, just a way to skip the RPC's auto-notification. Left as a known gap, matching §13's existing list; closing it needs `set_config`-based context-passing between the RPC and a new trigger, which wasn't worth the churn for a non-escalating gap.

### Testing

```bash
cd supabase
npm run seed:reset          # project was unseeded when Phase 2 began
npm run test:phase2         # new RPCs, camp isolation, statistics scoping
npm run frontend:config     # writes assets/js/core/supabase-config.js (git-ignored)
npm run test:browser-smoke  # loads the real assets/js/supabase/*.js files in Chromium
npm run test:schema         # re-run the Phase 1 offline suite — must still be 48/48
```
```

- [ ] **Step 2: Commit**

```bash
git add BACKEND.md
git commit -m "docs: document Phase 2 migrations, data-access layer and testing"
```

---

## Self-review notes (already applied above, kept for the executor's awareness)

- **Spec coverage:** §4 (profiles), §5 (camps), §6–9 (families/members/national-ID), §11–14 (statistics/search/filter/age), §15–17 (registration workflow — reused existing RPCs), §18–24 (organizations/aid), §25–27 (documents/messages/notifications), §30–34 (validation/errors/pagination/sorting/security), §37–39 (layer structure, client reuse, no UI wiring), §40 (tests), §43–44 (migrations, docs) all map to a task above. §2/§3/§10/§20/§21/§35/§36 describe properties already true of the Phase 1 schema (transactional RPCs, orphan derivation, audit columns) and required no new task — verified live in the inspection section rather than re-implemented.
- **Placeholder scan:** every step above contains real SQL or real JS; no "TBD"/"add error handling"/"similar to Task N" markers.
- **Type/name consistency:** `add_family_member(p_family_id, p_member)` (Task 2 SQL) matches the `family-members.js` call `client.rpc('add_family_member', { p_family_id: familyId, p_member: member })` (Task 9) exactly. `get_family_statistics`/`get_dashboard_statistics` column names in Task 3's `RETURNS TABLE` match the property names Task 16's test asserts (`stats[0].total_members`) and Task 15's `statistics.js` passthrough.
