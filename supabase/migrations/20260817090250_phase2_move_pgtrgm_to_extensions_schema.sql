-- supabase/migrations/20260817090250_phase2_move_pgtrgm_to_extensions_schema.sql
-- The prior migration installed pg_trgm without a target schema, which
-- defaulted it into `public` and tripped the `extension_in_public` security
-- advisory. This project already keeps its other extensions (pgcrypto,
-- pg_stat_statements, uuid-ossp) in `extensions` — move pg_trgm there too
-- rather than leave a new, avoidable WARN.

alter extension pg_trgm set schema extensions;
