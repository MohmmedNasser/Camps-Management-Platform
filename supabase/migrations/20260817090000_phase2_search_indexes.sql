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
