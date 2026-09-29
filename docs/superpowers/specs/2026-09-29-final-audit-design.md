# Final Audit — Pre-React Migration Readiness (design)

Date: 2026-09-29 · Branch `main` @ `0fe97b6` · Live project `qlvftlecwoqmvtagaykr`

Audit and stabilisation only. No React, no rewrite, no schema/RLS change. The working tree and the live Supabase project were treated as the source of truth, not earlier phase reports.

## 1. Scope

Every page module, every `assets/js/supabase/*` data-access module, 5 Edge Functions, the live RLS/RPC/trigger/grant state, the 43 test files, and CLAUDE.md / BACKEND.md / README.md accuracy.

Out of scope: React scaffolding, redesign, data-layer redesign, new features.

## 2. Current architecture

```
supabase/*.js (18 modules, 2.5k LOC)  →  core/selectors.js (pure)  →  pages/*.js (37 modules, 8.7k LOC)  →  ui/*.js (12 modules, 3.8k LOC)
```

- Static HTML shells (35 files in `pages/`), vanilla ES modules, one shared Supabase client (`core/supabase-client.js`, supabase-js pinned `2.58.0` from esm.sh), Chart.js from jsdelivr.
- Identity: `auth.uid()` → `profiles` (`role`, `camp_id`, `family_member_id`, `status`). No role comes from URL/localStorage. `core/auth.js` `can()` / `inScope()` are UX only.
- Total: ~17.3k JS LOC, ~3.8k CSS LOC. `core/store.js` is only `load(producer, delay)`.
- Backend: 14 tables in `public` + `private.family_activation_tokens`, 52 RLS policies, 35 `SECURITY DEFINER` functions, 5 Edge Functions, 27 migrations applied live.

## 3. Roles and page inventory

`PAGE_ACCESS` (25 in-app pages) plus 10 public/utility pages (`index`, `login`, `register`, `forgot-password`, `reset-password`, `activate-family`, `pending`, `rejected`, `404`, `auth-error`) and `design-system` (dev reference).

| Page | super_admin | camp_admin | displaced | Data source |
|---|---|---|---|---|
| dashboard | ✔ | ✔ | ✔ | `supabase/dashboard.js` (3 composers) |
| displaced, displaced-details | ✔ (read) | ✔ | – | `family-members.js` |
| displaced-create / -edit | – | ✔ | – | `family-members.js` |
| families, family-details | ✔ (read) | ✔ | details only ("أسرتي") | `families.js` |
| family-create | – | ✔ | – | RPC `create_family_with_members` |
| aid | ✔ (read) | ✔ | ✔ (own family list) | `aids.js` |
| aid-details | ✔ | ✔ | – | `aids.js` |
| aid-create / -edit | – | ✔ | – | RPC `create_aid_distribution` + junction diff |
| organizations | ✔ | ✔ | – | `organizations.js` |
| registration-requests (+details) | – | ✔ | – | RPCs approve/reject |
| documents | ✔ | ✔ | ✔ (own family) | `documents.js` + Edge Functions |
| messages / details / compose | ✔ | ✔ | ✔ | `messages.js` |
| notifications, profile, settings | ✔ | ✔ | ✔ | `notifications.js`, `profiles.js`, `preferences.js` |
| camps, camp-admins, statistics | ✔ | – | – | `camps.js`, `profiles.js`, `core/selectors.js` aggregations |

Real-data pages: 25/25. Remaining mock pages: 0. Mock remnants are stale comments only (see §8).

## 4. Security boundaries

1. **RLS** — all `public` tables have RLS on; `private.family_activation_tokens` has no RLS but `anon`/`authenticated` hold no grants on it and `private` is not exposed.
2. **RPCs** — write-side invariants are enforced with `private.is_browser_session()` (`session_user = 'authenticator'` and JWT role ≠ `service_role`) plus `is_camp_admin() AND current_camp_id() = target`. Each browser-callable `SECURITY DEFINER` RPC checks role/camp itself.
3. **Edge Functions** — `documents-*` and `admin-create-camp-admin` use `verify_jwt: true`; `admin-create-camp-admin` re-derives the caller's role from the DB. `activate-family-account` is intentionally anonymous (`verify_jwt: false`), guarded by a hashed single-use token + identity verification with one generic error.
4. **Secrets** — `service_role` / Cloudinary secrets exist only in Edge Function env and `.env` (git-ignored). Repo-wide search of `assets/` and `pages/` finds only comments.

## 5. Authentication flows

Login / logout / session persistence (`dcmp.auth` storage key), password reset (forgot → email → reset-password), Camp Admin creation (Edge Function), family activation (token → verify → `auth.admin.createUser` → `consume_family_activation`), registration → approval → activated account. Covered by phase4.1, 4.11, 4.17 suites; re-verified independently in this audit (§9).

## 6. Data ownership

- Camp scope: `families.camp_id`, `family_members.camp_id` (synced trigger), `documents`, `aid_distributions`, `messages`, `registration_requests`.
- Family scope: `private.current_family_id()` for displaced reads (own family, own family's documents/aid).
- Account scope: `notifications`, `user_preferences` (`recipient_id/user_id = auth.uid()`); no INSERT/DELETE on notifications from the client — notifications are written by `SECURITY DEFINER` triggers.

## 7. Identified risks (see the final report for severity)

| # | Risk | Class |
|---|---|---|
| R1 | `npm run seed` imported the deleted `data/mock-data.js`; DB was not reproducible from the repo | **fixed** |
| R2 | List/statistics/export functions (`getAll*`, `getCamp*`) fetch entire tables client-side; PostgREST `max_rows = 1000` will silently truncate lists, exports and statistics beyond 1000 rows | scaling, non-blocking today (39 members) |
| R3 | README.md described the mock/localStorage architecture; CLAUDE.md `ui/upload.js` note stale | **fixed** |
| R4 | Live migration history ≠ local migration files (7 extra live versions: temp session-binding probes, follow-up fixes); local files are a consolidated superset | documentation/ops |
| R5 | Leaked-password protection disabled (Auth); activation/edge password minimum is 6 chars | hardening |
| R6 | Invalid (non-UUID) `?id=` on `displaced-details`, `aid-details`, `message-details` shows the generic error + retry instead of "not found" | UX, non-blocking |
| R7 | `auth.signOut()` uses default global scope — signing out on one device revokes all sessions of the account | behaviour note |
| R8 | One stale `pending` displaced profile (`ياسر الريس`, 2026-09-28) with no registration request and no family member | ambiguous data, not modified |
| R9 | `esm.sh` / jsdelivr CDNs load at runtime with no SRI | supply-chain, accepted for prototype |
| R10 | The shell issues ~5 requests per page (notification list + unread count, messages, pending, preferences) and dashboards repeat the unread count | perf, accepted (Phase 4.16) |

## 8. Testing strategy

- Static: import-resolution script over `assets/js` (every relative import resolves; no file imports the deleted layer), repo-wide grep for mock/secret patterns.
- Live DB: policies, function grants, advisors (security + performance), integrity queries.
- Direct-RLS probe with real sessions (anon, camp admin ×2, displaced, super): cross-camp / cross-family reads, escalation writes, RPC abuse. Frontend bypassed.
- Playwright sweep: every page × 3 roles × both URL styles (`x.html` with serve-style redirect that drops the query, and `x`), console/network errors, 7 viewport widths.
- Full `npm run test:all` (37 suites).

## 9. React-readiness criteria

Ready if: (a) every page reads real data through `supabase/*.js`; (b) authorization is enforced by RLS/RPC/Edge, not the UI; (c) data-access and pure-logic layers are DOM-free and separable; (d) tests exist per role and are green; (e) no critical security/data-integrity issue remains. Classification per layer is in the final report.
