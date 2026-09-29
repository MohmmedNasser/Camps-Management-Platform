# Final Audit — Execution Plan (2026-09-29)

Inline execution only (no subagents). Companion to `docs/superpowers/specs/2026-09-29-final-audit-design.md`. Audit and stabilisation, **not** the React migration; no push to origin.

## Remediation rules

- Critical security / data-integrity defect → fix before closing the audit.
- Small, isolated, confirmed bug → fix, one focused commit.
- Large missing feature, UI improvement, perf optimisation, React architecture → document only.
- Never modify ambiguous data; never change RLS to satisfy a test; never weaken the activation model.

## Tasks

| # | Task | Evidence to collect | Commands | Decision criterion |
|---|---|---|---|---|
| 0 | Baseline | branch, HEAD, ahead/behind, dirty files | `git status`, `git log`, `git rev-list --left-right --count origin/main...HEAD` | record; nothing pushed |
| A | Page inventory | page × role × data source table; mock remnants | `PAGE_ACCESS`, grep `mock\|fake\|localStorage\|TODO` | any page with mock data path = blocker |
| B | Role matrix | RLS policy list, RPC guards | `pg_policies`, `pg_get_functiondef` | any write path lacking DB-side role/camp check = blocker |
| C | Auth lifecycle | login/logout/activation/reset results | phase4-auth-frontend, 4.11, 4.17 suites + Playwright login | any failed flow = blocker |
| D/H | Identity + cross-role isolation | direct-RLS probe output (anon, camp A/B, displaced, super), escalation attempts | ad-hoc node probe with real sessions | any cross-scope read/write succeeding = critical |
| E | RLS / DB security | policies, RLS-off tables, SECURITY DEFINER grants, advisors | SQL + `get_advisors` | new unexplained advisor finding = investigate |
| F/T | Edge Functions + secret scan | verify_jwt, service_role use, grep of `assets/ pages/` | `list_edge_functions`, `grep service_role\|SECRET` | any secret reachable from browser = critical |
| G/M | CRUD, search/filter/pagination/export | existing verification suites | `npm run test:all` | failing suite = investigate root cause |
| I | Data integrity | orphans, duplicates, tokens, test debris | integrity SQL | fix only if safe; ambiguous → report |
| J | Mock removal | import-resolution script; unused exports | node script over `assets/js` | unresolved import = blocker |
| K/P | Error handling, redundant requests | `Promise.all` sites, shell fetch count, invalid-id behaviour | grep + Playwright bad-id pass | page blank on partial failure = bug |
| L/Q | Browser verification | console/network errors, guard behaviour, 7 widths | Playwright sweep (both URL styles) | unexpected redirect or console error not explained by test interference = bug |
| N/O | Notifications, session preservation | dashboard vs header vs page counts; `auth.uid()` before/after | phase4.14–4.16, 4.11, 4.17 suites | mismatch = bug |
| R | Docs vs reality | README/CLAUDE.md/BACKEND.md statements | grep + manual diff | correct only demonstrably wrong statements |
| S | Test-suite integrity | fixed counts, sleeps, global sign-outs, cleanup | grep over `supabase/tests` | document; fix only if it causes false pass/fail |
| U | React-readiness classification | per-layer table | LOC + grep of DOM coupling | produce estimate, no refactor |

## Final gates

`npm run test:all` exit 0 · no critical findings open · `git status` reviewed · nothing pushed.
